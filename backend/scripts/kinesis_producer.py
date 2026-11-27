"""Amazon Kinesis Data Streams producer script for FraudShield transactions.

Usage:
    python scripts/kinesis_producer.py --count 50 --stream my-fraud-stream

Features:
- Takes --count (default: 20, max: 1000) and --stream (falls back to FRAUDSHIELD_KINESIS_STREAM).
- Refuses to run with a clear error if no stream name is configured.
- Generates synthetic transactions via simulator.normal_txn().
- Serializes transactions to JSON matching the Transaction schema.
- Sends records using put_records in batches of at most 500 records.
- PartitionKey is set to txn.sender_id.
- Prints the ShardId and SequenceNumber for each record.
- Exits non-zero on any record failure.
- Uses standard AWS credential chain (no hardcoded credentials or region secrets).
"""
import argparse
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Ensure backend root is on sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas import Transaction
from app import simulator


def parse_args(args: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stream synthetic FraudShield transactions into Amazon Kinesis."
    )
    parser.add_argument(
        "--count",
        type=int,
        default=20,
        help="Number of transactions to produce (1-1000, default: 20)",
    )
    parser.add_argument(
        "--stream",
        type=str,
        default=None,
        help="Target Kinesis stream name (falls back to FRAUDSHIELD_KINESIS_STREAM)",
    )
    return parser.parse_args(args)


def send_batch(
    kinesis_client: Any,
    stream_name: str,
    transactions: List[Transaction],
) -> int:
    """Send a batch of up to 500 transactions to Kinesis via put_records."""
    records: List[Dict[str, Any]] = []
    for txn in transactions:
        data_bytes = txn.model_dump_json().encode("utf-8")
        records.append({
            "Data": data_bytes,
            "PartitionKey": txn.sender_id,
        })

    response = kinesis_client.put_records(
        StreamName=stream_name,
        Records=records,
    )

    failed_record_count = response.get("FailedRecordCount", 0)
    records_output = response.get("Records", [])

    for idx, rec in enumerate(records_output):
        if "ErrorCode" in rec:
            print(
                f"[ERROR] Record {idx} failed: {rec.get('ErrorCode')} - {rec.get('ErrorMessage')}",
                file=sys.stderr,
            )
        else:
            shard_id = rec.get("ShardId")
            seq_num = rec.get("SequenceNumber")
            txn_id = transactions[idx].txn_id
            print(f"[OK] txn={txn_id} ShardId={shard_id} SequenceNumber={seq_num}")

    return failed_record_count


def run_producer(
    count: int = 20,
    stream_name: Optional[str] = None,
    client: Optional[Any] = None,
) -> int:
    """Core producer logic. Returns exit code (0 for success, 1 on failure)."""
    target_stream = stream_name or os.environ.get("FRAUDSHIELD_KINESIS_STREAM")
    if not target_stream or not target_stream.strip():
        print(
            "Error: Kinesis stream name is required. Specify --stream or set FRAUDSHIELD_KINESIS_STREAM.",
            file=sys.stderr,
        )
        return 1

    target_stream = target_stream.strip()

    if count < 1 or count > 1000:
        print(f"Error: --count must be between 1 and 1000 (received {count}).", file=sys.stderr)
        return 1

    if client is None:
        try:
            import boto3
        except ImportError:
            print(
                "Error: boto3 is not installed. Install it via `pip install boto3` to use the Kinesis producer.",
                file=sys.stderr,
            )
            return 1

        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        client_kwargs: Dict[str, Any] = {}
        if region:
            client_kwargs["region_name"] = region
        client = boto3.client("kinesis", **client_kwargs)

    print(f"Generating {count} synthetic transactions...")
    txns = [simulator.normal_txn() for _ in range(count)]

    # Batch into chunks of at most 500
    batch_size = 500
    total_failures = 0

    for i in range(0, len(txns), batch_size):
        chunk = txns[i : i + batch_size]
        print(f"Sending batch {i // batch_size + 1} ({len(chunk)} records) to stream '{target_stream}'...")
        failures = send_batch(client, target_stream, chunk)
        total_failures += failures

    if total_failures > 0:
        print(f"Completed with {total_failures} failed records.", file=sys.stderr)
        return 1

    print(f"Successfully streamed {count} records to '{target_stream}'.")
    return 0


def main() -> None:
    args = parse_args()
    code = run_producer(count=args.count, stream_name=args.stream)
    sys.exit(code)


if __name__ == "__main__":
    main()
