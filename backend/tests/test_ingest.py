"""Unit tests for transaction ingestion and Kinesis producer.

Guarantees:
- InMemorySource yields valid transactions without boto3.
- Producer exits with error code 1 when no stream name is configured.
- Producer transaction JSON serialization round-trips to an equal Transaction object.
- KinesisSource and producer batch logic execute cleanly against monkeypatched clients.
- Zero network calls to AWS.
"""
import json
import os
import sys
from unittest.mock import MagicMock

import pytest

from app.ingest import InMemorySource, KinesisSource, get_transaction_source
from app.schemas import Transaction
from app.simulator import normal_txn
from scripts.kinesis_producer import parse_args, run_producer, send_batch


def test_in_memory_source_yields_transactions_without_boto3():
    """Verify InMemorySource yields valid Transaction objects with no cloud dependencies."""
    source = InMemorySource()
    assert source.is_available() is True

    txns = source.get_transactions(limit=15)
    assert len(txns) == 15
    for t in txns:
        assert isinstance(t, Transaction)
        assert t.txn_id.startswith("TXN_")
        assert t.amount > 0
        assert t.sender_id.startswith("ACC_")
        assert t.receiver_id.startswith("ACC_")


def test_get_transaction_source_factory(monkeypatch):
    """Verify factory returns InMemorySource by default, and KinesisSource when stream is set."""
    monkeypatch.delenv("FRAUDSHIELD_KINESIS_STREAM", raising=False)
    default_src = get_transaction_source()
    assert isinstance(default_src, InMemorySource)

    monkeypatch.setenv("FRAUDSHIELD_KINESIS_STREAM", "test-fraud-stream")
    kinesis_src = get_transaction_source()
    assert isinstance(kinesis_src, KinesisSource)
    assert kinesis_src.stream_name == "test-fraud-stream"


def test_producer_exits_when_no_stream_name(monkeypatch, capsys):
    """Verify producer exits with status 1 when stream name is missing."""
    monkeypatch.delenv("FRAUDSHIELD_KINESIS_STREAM", raising=False)
    exit_code = run_producer(count=10, stream_name=None)
    assert exit_code == 1

    captured = capsys.readouterr()
    assert "Error: Kinesis stream name is required" in captured.err


def test_producer_transaction_serialization_roundtrip():
    """Verify JSON serialization from producer round-trips to an identical Transaction."""
    original = normal_txn()
    serialized_bytes = original.model_dump_json().encode("utf-8")

    # Deserialize back
    deserialized_dict = json.loads(serialized_bytes.decode("utf-8"))
    restored = Transaction(**deserialized_dict)

    assert restored.txn_id == original.txn_id
    assert restored.timestamp == original.timestamp
    assert restored.sender_id == original.sender_id
    assert restored.receiver_id == original.receiver_id
    assert restored.amount == original.amount
    assert restored.device_id == original.device_id
    assert restored.ip == original.ip
    assert restored.channel == original.channel


def test_producer_send_batch_success(capsys):
    """Verify put_records batch sending with fake client and output formatting."""
    fake_client = MagicMock()
    fake_client.put_records.return_value = {
        "FailedRecordCount": 0,
        "Records": [
            {"ShardId": "shardId-000000000000", "SequenceNumber": "4958291029481"},
            {"ShardId": "shardId-000000000000", "SequenceNumber": "4958291029482"},
        ],
    }

    sample_txns = [normal_txn(), normal_txn()]
    failures = send_batch(fake_client, "my-stream", sample_txns)
    assert failures == 0

    fake_client.put_records.assert_called_once()
    call_kwargs = fake_client.put_records.call_args[1]
    assert call_kwargs["StreamName"] == "my-stream"
    assert len(call_kwargs["Records"]) == 2
    assert call_kwargs["Records"][0]["PartitionKey"] == sample_txns[0].sender_id

    captured = capsys.readouterr()
    assert "ShardId=shardId-000000000000" in captured.out
    assert "SequenceNumber=4958291029481" in captured.out


def test_producer_send_batch_failure(capsys):
    """Verify failed records are reported and increment failure count."""
    fake_client = MagicMock()
    fake_client.put_records.return_value = {
        "FailedRecordCount": 1,
        "Records": [
            {"ShardId": "shardId-000000000000", "SequenceNumber": "4958291029481"},
            {"ErrorCode": "ProvisionedThroughputExceededException", "ErrorMessage": "Rate exceeded"},
        ],
    }

    sample_txns = [normal_txn(), normal_txn()]
    failures = send_batch(fake_client, "my-stream", sample_txns)
    assert failures == 1

    captured = capsys.readouterr()
    assert "ProvisionedThroughputExceededException" in captured.err


def test_kinesis_source_get_transactions_with_mock_client():
    """Verify KinesisSource correctly parses records from mock Kinesis client."""
    sample_txn = normal_txn()
    fake_client = MagicMock()
    fake_client.describe_stream.return_value = {
        "StreamDescription": {"Shards": [{"ShardId": "shard-1"}]}
    }
    fake_client.get_shard_iterator.return_value = {"ShardIterator": "iter-token-1"}
    fake_client.get_records.return_value = {
        "NextShardIterator": "iter-token-2",
        "Records": [
            {"Data": sample_txn.model_dump_json().encode("utf-8")},
        ],
    }

    source = KinesisSource(stream_name="test-stream", kinesis_client=fake_client)
    records = source.get_transactions(limit=1)

    assert len(records) == 1
    assert records[0].txn_id == sample_txn.txn_id
    assert records[0].sender_id == sample_txn.sender_id
