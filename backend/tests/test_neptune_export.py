"""Tests for Neptune CSV bulk load exporter script."""
import csv
from pathlib import Path

from scripts.export_neptune_csv import export_neptune_csv, get_graph_data


def test_neptune_csv_headers_and_labels(tmp_path: Path):
    """Verify Neptune CSV export produces exact required headers and labels."""
    sample_graph = {
        "nodes": [
            {"id": "ACC_0001", "risk": 85, "ring_id": "RING_123", "txn_count": 5},
            {"id": "ACC_0002", "risk": 10, "ring_id": None, "txn_count": 2},
        ],
        "edges": [
            {"source": "ACC_0001", "target": "ACC_0002", "amount": 5400.0, "count": 3},
        ],
        "rings": [],
    }

    v_path, e_path = export_neptune_csv(sample_graph, tmp_path)

    assert v_path.exists()
    assert e_path.exists()

    # 1. Verify vertices.csv headers: ~id, ~label, risk, ring_id, txn_count
    with open(v_path, "r", encoding="utf-8") as f:
        reader = list(csv.reader(f))
        assert len(reader) >= 3  # header + 2 nodes
        header = reader[0]
        assert header == ["~id", "~label", "risk", "ring_id", "txn_count"]

        # Verify ~label is always "Account"
        for row in reader[1:]:
            assert row[1] == "Account"
            assert row[0] in ["ACC_0001", "ACC_0002"]

    # 2. Verify edges.csv headers: ~id, ~from, ~to, ~label, amount, count
    with open(e_path, "r", encoding="utf-8") as f:
        reader = list(csv.reader(f))
        assert len(reader) >= 2  # header + 1 edge
        header = reader[0]
        assert header == ["~id", "~from", "~to", "~label", "amount", "count"]

        # Verify ~label is always "PAID"
        for row in reader[1:]:
            assert row[3] == "PAID"
            assert row[1] == "ACC_0001"
            assert row[2] == "ACC_0002"
            assert float(row[4]) == 5400.0
            assert int(row[5]) == 3


def test_neptune_csv_empty_graph_headers(tmp_path: Path):
    """Verify Neptune CSV export produces valid headers even with an empty graph."""
    empty_graph = {"nodes": [], "edges": [], "rings": []}
    v_path, e_path = export_neptune_csv(empty_graph, tmp_path)

    with open(v_path, "r", encoding="utf-8") as f:
        header = next(csv.reader(f))
        assert header == ["~id", "~label", "risk", "ring_id", "txn_count"]

    with open(e_path, "r", encoding="utf-8") as f:
        header = next(csv.reader(f))
        assert header == ["~id", "~from", "~to", "~label", "amount", "count"]
