"""Unit and integration tests for FraudShield Multi-Model Ensemble."""
import math
import os
import time
import pytest

from app.graph_engine import GraphEngine
from app.ml import FEATURE_NAMES, extract_features
from app.models_ensemble import (
    ANOMALY_FEATURES,
    DEVICE_FEATURES,
    GRAPH_FEATURES,
    META_FEATURE_NAMES,
    BehaviourProfileModel,
    FraudEnsemble,
    GLOBAL_ENSEMBLE,
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


def test_feature_sets_definitions():
    """Verify feature sets are well-formed subsets of the 19 standard features."""
    assert len(FEATURE_NAMES) == 19
    for f in ANOMALY_FEATURES:
        assert f in FEATURE_NAMES
    for f in GRAPH_FEATURES:
        assert f in FEATURE_NAMES
    for f in DEVICE_FEATURES:
        assert f in FEATURE_NAMES
    assert len(META_FEATURE_NAMES) == 6


def test_behaviour_profile_cold_start_and_updates():
    """Verify BehaviourProfileModel handles cold-start gracefully and updates online."""
    model = BehaviourProfileModel()
    
    # Cold start: account not seen before
    score_cold = model.predict_score("ACC_NEW_1", 5000.0, "ACC_REC_1")
    assert 0.0 <= score_cold <= 1.0
    assert score_cold == 0.15  # Designed cold-start baseline

    # Add 10 normal payments around 1,000 INR
    for _ in range(10):
        model.update_account("ACC_USER_1", 1000.0, "ACC_MERCHANT_1")

    # Payment matching profile to familiar receiver -> low score
    score_normal = model.predict_score("ACC_USER_1", 1050.0, "ACC_MERCHANT_1")
    assert 0.0 <= score_normal <= 0.35

    # Sudden huge anomalous payment to new receiver -> high score
    score_spike = model.predict_score("ACC_USER_1", 50000.0, "ACC_STRANGER_9")
    assert score_spike > score_normal
    assert 0.5 <= score_spike <= 1.0


def test_specialist_models_prediction_range():
    """Verify each loaded specialist produces bounded predictions in [0.0, 1.0]."""
    state = EngineState()
    graph_engine = GraphEngine()
    txn = normal_txn()
    features = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())

    ensemble = GLOBAL_ENSEMBLE
    if not ensemble.is_loaded:
        pytest.skip("Models not yet available on disk")

    s_sup = ensemble.predict_supervised(features)
    assert 0.0 <= s_sup <= 1.0

    s_anom = ensemble.predict_anomaly(features)
    assert 0.0 <= s_anom <= 1.0

    s_prof = ensemble.predict_profile(txn)
    assert 0.0 <= s_prof <= 1.0

    s_graph = ensemble.predict_graph(features)
    assert 0.0 <= s_graph <= 1.0

    s_dev = ensemble.predict_device(features)
    assert 0.0 <= s_dev <= 1.0

    meta = ensemble.predict_meta(s_sup, s_anom, s_prof, s_graph, s_dev, rule_score=0)
    assert 0.0 <= meta <= 1.0


def test_ensemble_score_transaction_contract():
    """Verify FraudEnsemble.score_transaction returns final score, breakdown dict, and reasons."""
    ensemble = GLOBAL_ENSEMBLE
    state = EngineState()
    graph_engine = GraphEngine()
    txn = normal_txn()
    features = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())

    final_score, model_scores, reasons = ensemble.score_transaction(features, rule_score=10, transaction=txn)

    assert isinstance(final_score, int)
    assert 0 <= final_score <= 100

    assert isinstance(model_scores, dict)
    expected_keys = {"supervised", "anomaly", "profile", "graph", "device", "meta"}
    for k in expected_keys:
        assert k in model_scores
        assert 0.0 <= model_scores[k] <= 1.0

    assert isinstance(reasons, list)


def test_scorer_integration_with_ensemble():
    """Verify score_transaction includes model_scores and reasons in ScoredTransaction."""
    txn = normal_txn()
    scored = score_transaction(txn)

    assert 0 <= scored.risk_score <= 100
    assert scored.decision in ["ALLOW", "REVIEW", "BLOCK"]
    assert scored.model_scores is not None
    assert "meta" in scored.model_scores
    assert scored.latency_ms >= 0.0


def test_ensemble_graceful_fallback_when_models_missing(tmp_path):
    """Verify FraudEnsemble falls back gracefully when initialized with empty directory."""
    empty_ensemble = FraudEnsemble(models_dir=str(tmp_path))
    assert not empty_ensemble.is_loaded

    state = EngineState()
    graph_engine = GraphEngine()
    txn = normal_txn()
    features = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())

    # Should not crash and should return safe score based on heuristic fusion
    score, breakdown, reasons = empty_ensemble.score_transaction(features, rule_score=40, transaction=txn)
    assert isinstance(score, int)
    assert 0 <= score <= 100
    assert "meta" in breakdown


def test_ensemble_latency_under_10ms():
    """Verify that scoring a transaction through the entire ensemble completes under 10 ms."""
    txn = normal_txn()
    latencies = []
    
    # Warmup
    for _ in range(5):
        score_transaction(txn)

    for _ in range(50):
        t0 = time.perf_counter()
        _ = score_transaction(txn)
        lat = (time.perf_counter() - t0) * 1000.0
        latencies.append(lat)

    avg_lat = sum(latencies) / len(latencies)
    assert avg_lat < 10.0, f"Average latency was {avg_lat:.2f} ms (must be < 10 ms)"
