"""Integration tests for FraudShield FastAPI endpoints and WebSocket streaming."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.simulator import normal_txn

client = TestClient(app)


def test_health():
    """Verify health endpoint readiness."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_score_contract_fields():
    """Verify POST /score contract fields and structure."""
    txn = normal_txn()
    payload = txn.model_dump()

    response = client.post("/score", json=payload)
    assert response.status_code == 200
    data = response.json()

    # Exact required contract fields
    assert "txn_id" in data
    assert data["txn_id"] == txn.txn_id
    assert "timestamp" in data
    assert "sender_id" in data
    assert "receiver_id" in data
    assert "amount" in data
    assert "risk_score" in data
    assert 0 <= data["risk_score"] <= 100
    assert "decision" in data
    assert data["decision"] in ["ALLOW", "REVIEW", "BLOCK"]
    assert "reasons" in data
    assert isinstance(data["reasons"], list)
    assert "ring_id" in data
    assert "latency_ms" in data
    assert isinstance(data["latency_ms"], (int, float))


def test_simulate_velocity_attack():
    """Verify POST /simulate/velocity_attack flags transactions with REVIEW or BLOCK."""
    client.post("/reset")
    response = client.post("/simulate/velocity_attack")
    assert response.status_code == 200
    data = response.json()

    assert data["scenario"] == "velocity_attack"
    assert data["count"] > 0
    # Must give at least one REVIEW or BLOCK decision
    assert (data["review"] + data["blocked"]) >= 1


def test_simulate_ring_attack_makes_graph_return_at_least_one_ring():
    """Verify POST /simulate/ring_attack causes GET /graph to return detected rings."""
    client.post("/reset")
    sim_resp = client.post("/simulate/ring_attack")
    assert sim_resp.status_code == 200
    assert sim_resp.json()["scenario"] == "ring_attack"

    # Query graph endpoint
    graph_resp = client.get("/graph")
    assert graph_resp.status_code == 200
    graph_data = graph_resp.json()

    # Verify graph structure
    assert "nodes" in graph_data
    assert "edges" in graph_data
    assert "rings" in graph_data
    assert len(graph_data["rings"]) >= 1, "Expected at least one ring in /graph"

    # Verify ring structure
    first_ring = graph_data["rings"][0]
    assert "ring_id" in first_ring
    assert "members" in first_ring
    assert isinstance(first_ring["members"], list)
    assert len(first_ring["members"]) >= 3
    assert "score" in first_ring

    # Verify nodes and edges contain expected fields
    assert len(graph_data["nodes"]) > 0
    node = graph_data["nodes"][0]
    assert "id" in node
    assert "risk" in node
    assert "ring_id" in node
    assert "txn_count" in node

    assert len(graph_data["edges"]) > 0
    edge = graph_data["edges"][0]
    assert "source" in edge
    assert "target" in edge
    assert "amount" in edge
    assert "count" in edge


def test_metrics_has_all_keys():
    """Verify GET /metrics returns all required metric fields."""
    response = client.get("/metrics")
    assert response.status_code == 200
    data = response.json()

    required_keys = {
        "total_txns",
        "avg_latency_ms",
        "p99_latency_ms",
        "tps",
        "allowed",
        "review",
        "blocked",
        "rings_detected",
    }
    assert required_keys.issubset(data.keys())
    assert isinstance(data["total_txns"], int)
    assert isinstance(data["avg_latency_ms"], (int, float))
    assert isinstance(data["p99_latency_ms"], (int, float))
    assert isinstance(data["tps"], (int, float))
    assert isinstance(data["allowed"], int)
    assert isinstance(data["review"], int)
    assert isinstance(data["blocked"], int)
    assert isinstance(data["rings_detected"], int)


def test_reset_clears_the_counts():
    """Verify POST /reset zeroes metrics and clears transactions."""
    # Score a transaction first
    txn = normal_txn()
    client.post("/score", json=txn.model_dump())

    # Reset
    reset_resp = client.post("/reset")
    assert reset_resp.status_code == 200

    # Verify metrics are zeroed
    metrics_resp = client.get("/metrics")
    metrics_data = metrics_resp.json()
    assert metrics_data["total_txns"] == 0
    assert metrics_data["allowed"] == 0
    assert metrics_data["review"] == 0
    assert metrics_data["blocked"] == 0
    assert metrics_data["rings_detected"] == 0

    # Verify recent transactions are cleared
    recent_resp = client.get("/transactions/recent")
    assert recent_resp.json() == []


def test_transactions_recent_returns_a_list():
    """Verify GET /transactions/recent returns a list of recent transactions."""
    client.post("/reset")
    txn = normal_txn()
    client.post("/score", json=txn.model_dump())

    response = client.get("/transactions/recent")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["txn_id"] == txn.txn_id


def test_websocket_stream():
    """Verify /stream WebSocket receives live scored transactions."""
    with client.websocket_connect("/stream") as websocket:
        txn = normal_txn()
        client.post("/score", json=txn.model_dump())
        event = websocket.receive_json()
        assert event["txn_id"] == txn.txn_id
        assert "risk_score" in event
        assert "decision" in event
