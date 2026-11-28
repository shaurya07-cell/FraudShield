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


def test_scorer_updates_graph_with_rule_score_parity():
    """Verify live scoring updates graph node risk strictly using rule_score / 100.0."""
    from app.graph_engine import GLOBAL_GRAPH
    from app.rules import evaluate, score_from_reasons
    from app.state import GLOBAL_STATE

    GLOBAL_GRAPH.reset()
    txn = normal_txn()

    # Pre-calculate expected rule_score
    reasons = evaluate(txn, state=GLOBAL_STATE)
    expected_rule_score = score_from_reasons(reasons)
    expected_risk = expected_rule_score / 100.0

    scored = score_transaction(txn)

    # Node risk in the graph must equal rule_score / 100.0
    actual_risk = GLOBAL_GRAPH.node_risk.get(txn.sender_id, 0.0)
    assert actual_risk == pytest.approx(expected_risk, abs=1e-5), (
        f"Graph node risk ({actual_risk}) does not match rule_score / 100.0 ({expected_risk}). "
        f"Scored final was {scored.risk_score}."
    )


def test_fraudshield_models_dir_env_override(tmp_path, monkeypatch):
    """Verify FRAUDSHIELD_MODELS_DIR override resolves correctly with fallback behavior."""
    from app.ml import get_models_dir, DEFAULT_MODELS_DIR

    # 1. When unset, defaults to backend/models
    monkeypatch.delenv("FRAUDSHIELD_MODELS_DIR", raising=False)
    assert get_models_dir() == DEFAULT_MODELS_DIR

    # 2. When set to a folder missing required files, falls back to default
    empty_temp = tmp_path / "empty_models"
    empty_temp.mkdir()
    monkeypatch.setenv("FRAUDSHIELD_MODELS_DIR", str(empty_temp))
    assert get_models_dir() == DEFAULT_MODELS_DIR

    # 3. When set to a folder containing required model file, resolves to that directory
    valid_temp = tmp_path / "valid_models"
    valid_temp.mkdir()
    (valid_temp / "fraud_model.joblib").write_text("dummy")
    monkeypatch.setenv("FRAUDSHIELD_MODELS_DIR", str(valid_temp))
    assert get_models_dir() == str(valid_temp.resolve())


def test_feature_contributions_differ_between_normal_and_high_amount():
    """Verify ML_MODEL reason names top 3 features with direction, differing between normal and high-amount."""
    t_normal = normal_txn()
    s_normal = score_transaction(t_normal)

    t_high = normal_txn()
    t_high.amount = 98500.0
    s_high = score_transaction(t_high)

    normal_ml_reasons = [r.detail for r in s_normal.reasons if r.rule == "ML_MODEL"]
    high_ml_reasons = [r.detail for r in s_high.reasons if r.rule == "ML_MODEL"]

    assert len(normal_ml_reasons) == 1, f"Expected 1 ML_MODEL reason, got: {normal_ml_reasons}"
    assert len(high_ml_reasons) == 1, f"Expected 1 ML_MODEL reason, got: {high_ml_reasons}"

    # Verify both directions (raises risk or lowers risk) and top 3 drivers are named
    for detail in [normal_ml_reasons[0], high_ml_reasons[0]]:
        assert ("raises risk" in detail) or ("lowers risk" in detail), f"Missing direction in reason: {detail}"
        # Names top 3 features (each followed by direction)
        direction_count = detail.count("raises risk") + detail.count("lowers risk")
        assert direction_count == 3, f"Expected 3 feature directions in reason, got {direction_count}: {detail}"

    # Reasons must differ between normal and high-amount transactions
    assert normal_ml_reasons[0] != high_ml_reasons[0], "Explanations should differ for different transactions"


def test_feature_contributions_fallback_when_model_missing(monkeypatch):
    """Verify graceful omission of ML_MODEL reasons when supervised booster cannot be computed."""
    from app.models_ensemble import GLOBAL_ENSEMBLE
    monkeypatch.setattr(GLOBAL_ENSEMBLE, "supervised_model", None)

    txn = normal_txn()
    scored = score_transaction(txn)

    # Scored transaction still succeeds
    assert 0 <= scored.risk_score <= 100
    assert scored.decision in ["ALLOW", "REVIEW", "BLOCK"]

    # No ML_MODEL reason is fabricated
    ml_reasons = [r for r in scored.reasons if r.rule == "ML_MODEL"]
    assert len(ml_reasons) == 0, f"Expected 0 fabricated ML_MODEL reasons, found: {ml_reasons}"


def test_graph_reason_absent_for_account_with_no_cluster():
    """Verify MODEL_GRAPH reason is never emitted for isolated normal accounts (neutral 0.467 not shown as finding)."""
    txn = normal_txn()
    scored = score_transaction(txn)

    # The model score is at the neutral baseline ~0.467
    assert scored.model_scores is not None
    assert scored.model_scores.get("graph") == 0.467

    # But the MODEL_GRAPH reason MUST be absent because there is no cluster/ring
    graph_reasons = [r for r in scored.reasons if r.rule == "MODEL_GRAPH"]
    assert len(graph_reasons) == 0, f"Expected no MODEL_GRAPH reason for isolated account, got: {graph_reasons}"


def test_graph_reason_present_with_real_data_for_ring():
    """Verify MODEL_GRAPH reason is emitted and references real ring/cycle data when genuine risk exists."""
    from app.graph_engine import GLOBAL_GRAPH
    from app.simulator import ring_attack

    ring_txns = ring_attack()
    for t in ring_txns:
        score_transaction(t)

    # Recompute graph cache to detect ring
    GLOBAL_GRAPH.recompute_cache()

    # Score an additional transaction involving a member of the ring
    member_txn = normal_txn()
    member_txn.sender_id = ring_txns[0].sender_id
    member_txn.receiver_id = ring_txns[0].receiver_id
    scored = score_transaction(member_txn)

    graph_reasons = [r for r in scored.reasons if r.rule == "MODEL_GRAPH"]
    assert len(graph_reasons) == 1, f"Expected 1 MODEL_GRAPH reason for ring member, got: {graph_reasons}"
    # Verify the detail reflects real data (e.g. ring, loop, or cluster)
    detail = graph_reasons[0].detail.lower()
    assert ("ring" in detail) or ("cyclical" in detail) or ("cluster" in detail), (
        f"Expected real graph data in reason, got: {graph_reasons[0].detail}"
    )




