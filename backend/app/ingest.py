"""Transaction ingestion sources for FraudShield.

Provides a unified TransactionSource interface supporting:
1. InMemorySource: default generator wrapping simulator.py (no cloud dependency).
2. KinesisSource: optional consumer streaming from Amazon Kinesis Data Streams.

Boto3 is imported lazily inside KinesisSource so that module load and testing
never require boto3 to be installed or initialized.
"""
import json
import logging
import os
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from app.schemas import Transaction
from app import simulator

logger = logging.getLogger(__name__)


class TransactionSource(ABC):
    """Abstract interface for ingesting transaction streams into FraudShield."""

    @abstractmethod
    def get_transactions(self, limit: int = 20) -> List[Transaction]:
        """Fetch or generate a batch of transactions up to the limit."""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """Check if the source is active and ready."""
        pass


class InMemorySource(TransactionSource):
    """Default simulated transaction source wrapping simulator.py."""

    def get_transactions(self, limit: int = 20) -> List[Transaction]:
        """Generate simulated legitimate consumer transactions."""
        count = max(1, min(limit, 1000))
        return [simulator.normal_txn() for _ in range(count)]

    def is_available(self) -> bool:
        return True


class KinesisSource(TransactionSource):
    """Optional transaction source reading records from an Amazon Kinesis Data Stream.

    Stream name is resolved from FRAUDSHIELD_KINESIS_STREAM.
    AWS Region is resolved from AWS_REGION (or AWS_DEFAULT_REGION).
    Uses the standard AWS credential chain.
    """

    def __init__(
        self,
        stream_name: Optional[str] = None,
        region_name: Optional[str] = None,
        kinesis_client: Optional[Any] = None,
    ):
        self.stream_name = stream_name or os.environ.get("FRAUDSHIELD_KINESIS_STREAM")
        self.region_name = (
            region_name
            or os.environ.get("AWS_REGION")
            or os.environ.get("AWS_DEFAULT_REGION")
        )
        self._client = kinesis_client
        self._shard_iterators: Dict[str, str] = {}

    def _get_client(self) -> Any:
        """Lazily initialize boto3 client using default credential chain."""
        if self._client is None:
            try:
                import boto3  # Lazy import
            except ImportError as err:
                raise RuntimeError(
                    "boto3 is required for KinesisSource but is not installed. "
                    "Install it via `pip install boto3`."
                ) from err

            client_kwargs: Dict[str, Any] = {}
            if self.region_name:
                client_kwargs["region_name"] = self.region_name
            self._client = boto3.client("kinesis", **client_kwargs)
        return self._client

    def is_available(self) -> bool:
        """Check if a valid stream name is configured."""
        return bool(self.stream_name and self.stream_name.strip())

    def get_transactions(self, limit: int = 20) -> List[Transaction]:
        """Read records from Kinesis and parse them into Transaction instances."""
        if not self.is_available():
            logger.warning("KinesisSource called but no stream name configured.")
            return []

        client = self._get_client()
        txns: List[Transaction] = []

        try:
            # If no shard iterators are cached, discover shards and initialize
            if not self._shard_iterators:
                stream_desc = client.describe_stream(StreamName=self.stream_name)
                shards = stream_desc.get("StreamDescription", {}).get("Shards", [])
                for shard in shards:
                    shard_id = shard["ShardId"]
                    iter_resp = client.get_shard_iterator(
                        StreamName=self.stream_name,
                        ShardId=shard_id,
                        ShardIteratorType="LATEST",
                    )
                    self._shard_iterators[shard_id] = iter_resp.get("ShardIterator")

            # Poll shards until limit is satisfied or iterators exhausted
            for shard_id, shard_iter in list(self._shard_iterators.items()):
                if not shard_iter:
                    continue
                if len(txns) >= limit:
                    break

                batch_limit = min(limit - len(txns), 100)
                resp = client.get_records(
                    ShardIterator=shard_iter,
                    Limit=batch_limit,
                )
                self._shard_iterators[shard_id] = resp.get("NextShardIterator")

                for record in resp.get("Records", []):
                    raw_data = record.get("Data")
                    if isinstance(raw_data, bytes):
                        raw_data = raw_data.decode("utf-8")
                    try:
                        parsed = json.loads(raw_data)
                        txns.append(Transaction(**parsed))
                    except Exception as parse_err:
                        logger.warning("Failed to deserialize Kinesis record: %s", parse_err)

        except Exception as exc:
            logger.error("Error reading from Kinesis stream %s: %s", self.stream_name, exc)

        return txns


def get_transaction_source() -> TransactionSource:
    """Factory returning KinesisSource if configured, else InMemorySource."""
    stream_name = os.environ.get("FRAUDSHIELD_KINESIS_STREAM")
    if stream_name and stream_name.strip():
        return KinesisSource(stream_name=stream_name.strip())
    return InMemorySource()
