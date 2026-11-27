"""Tests for the machine learning scoring and feature extraction layer."""
import math
import os
import time
import pytest

from app.graph_engine import GraphEngine
from app.ml import (
    FEATURE_NAMES,
    FraudMLModel,
    extract_features,
    get_top_feature,
    is_model_loaded,
    predict_proba,
)
from app.schemas import Transaction
from app.scorer import score_transaction
from app.simulator import normal_txn, ring_attack, velocity_attack
from app.state import EngineState, reset


@pytest.fixture(autouse=True)
def clean_state():
    reset()
    yield
    reset()


def test_extract_features_contains_all_19_keys_and_no_nans():
    state = EngineState()
    graph_engine = GraphEngine()
    txn = normal_txn()

    features = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())

    # Verify all 19 features are present
    assert len(features) == len(FEATURE_NAMES)
    for name in FEATURE_NAMES:
        assert name in features, f"Missing feature {name}"
        val = features[name]
        assert isinstance(val, (int, float)), f"Feature {name} is not numeric: {type(val)}"
        assert not math.isnan(val), f"Feature {name} is NaN"
        assert not math.isinf(val), f"Feature {name} is Infinite"


def test_extract_features_dynamic_updates():
    state = EngineState()
    graph_engine = GraphEngine()

    vel_txns = velocity_attack(n=10)
    for i, txn in enumerate(vel_txns):
        features = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())
        assert features["amount"] == float(txn.amount)
        assert features["sender_txn_count_1m"] == float(i + 1)
        state.update(txn)
        graph_engine.add_transaction(txn)


def test_extract_features_cycle_and_round_trip():
    state = EngineState()
    graph_engine = GraphEngine()

    ring_txns = ring_attack(size=3, laps=2)
    for txn in ring_txns:
        state.update(txn)
        graph_engine.add_transaction(txn)

    cache = graph_engine.recompute_cache()
    test_txn = ring_txns[-1]
    features = extract_features(test_txn, state=state, graph_cache=cache)

    assert features["in_cycle"] == 1.0
    assert features["device_shared_accounts"] >= 3.0


def test_model_loading_and_prediction():
    model = FraudMLModel()
    if not model.is_loaded:
        pytest.skip("Model artifact not yet generated on disk")

    assert model.is_loaded is True
    sample_features = {name: 1.0 for name in FEATURE_NAMES}
    prob = model.predict_proba(sample_features)

    assert isinstance(prob, float)
    assert 0.0 <= prob <= 1.0

    top_feat = model.get_top_feature(sample_features)
    assert isinstance(top_feat, str)
    assert top_feat in FEATURE_NAMES


def test_scorer_blended_scoring_and_reason():
    txn = normal_txn()
    scored = score_transaction(txn)

    assert 0 <= scored.risk_score <= 100
    assert scored.decision in ["ALLOW", "REVIEW", "BLOCK"]
    assert scored.latency_ms >= 0.0

    # If model is loaded, ML_MODEL reason must be included
    if is_model_loaded():
        reason_rules = [r.rule for r in scored.reasons]
        assert "ML_MODEL" in reason_rules


def test_scorer_graceful_fallback_when_model_missing(monkeypatch):
    # Simulate missing model
    fake_model = FraudMLModel(model_path="non_existent_model.joblib")
    monkeypatch.setattr("app.scorer.is_model_loaded", lambda: False)

    txn = normal_txn()
    scored = score_transaction(txn)

    assert 0 <= scored.risk_score <= 100
    assert scored.decision in ["ALLOW", "REVIEW", "BLOCK"]


def test_predict_proba_latency_under_2ms():
    model = FraudMLModel()
    if not model.is_loaded:
        pytest.skip("Model artifact not yet generated on disk")

    sample_features = {name: 0.5 for name in FEATURE_NAMES}
    latencies = []
    for _ in range(200):
        t0 = time.perf_counter()
        _ = model.predict_proba(sample_features)
        lat_ms = (time.perf_counter() - t0) * 1000.0
        latencies.append(lat_ms)

    avg_lat = sum(latencies) / len(latencies)
    assert avg_lat < 2.0, f"Average latency was {avg_lat:.4f} ms, exceeded 2.0 ms budget"
