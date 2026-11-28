"""Scorer coordinating rules, graph cache, and ML scoring."""
import time
import numpy as np
import xgboost as xgb
from typing import Dict, List, Optional

from app.graph_engine import GLOBAL_GRAPH
from app.metrics import METRICS
from app.ml import extract_features, is_model_loaded, predict_proba, FEATURE_NAMES, GLOBAL_ML
from app.models_ensemble import GLOBAL_ENSEMBLE
from app.rules import evaluate, score_from_reasons
from app.schemas import Reason, ScoredTransaction, Transaction
from app.state import GLOBAL_STATE, EngineState


FEATURE_LABELS = {
    "amount": "Transaction amount",
    "amount_ratio_to_sender_avg": "Amount ratio to historical average",
    "sender_txn_count_1m": "1-minute transaction velocity",
    "sender_txn_count_5m": "5-minute transaction velocity",
    "sender_account_age_seconds": "Sender account age",
    "sender_distinct_receivers_5m": "Distinct receivers fan-out (5m)",
    "receiver_distinct_senders_5m": "Distinct senders fan-in (5m)",
    "device_shared_accounts": "Accounts sharing device",
    "is_round_trip": "Direct circular flow",
    "in_cycle": "Closed cyclical loop",
    "component_size": "Network cluster size",
    "neighbor_avg_risk": "Neighbor average risk",
    "sender_pagerank": "Sender network authority",
    "receiver_pagerank": "Receiver network authority",
    "sender_in_degree": "Sender inbound connections",
    "sender_out_degree": "Sender outbound connections",
    "receiver_in_degree": "Receiver inbound connections",
    "receiver_out_degree": "Receiver outbound connections",
    "receiver_account_age_seconds": "Receiver account age",
}


def _format_feature_val(fname: str, val: float) -> str:
    """Format feature value into human-readable string."""
    if fname == "amount":
        return f"₹{val:,.2f}"
    if "age_seconds" in fname:
        return f"{int(val)}s"
    if any(k in fname for k in ("count", "distinct", "shared", "in_degree", "out_degree")) or fname in (
        "component_size",
        "in_cycle",
        "is_round_trip",
    ):
        return f"{int(val)}"
    if "ratio" in fname:
        return f"{val:.1f}x"
    if "risk" in fname or "prob" in fname:
        return f"{val:.1%}"
    return f"{val:.2f}"


def _compute_xgb_reasons(model, features: Dict[str, float], ensemble_score: int = 10) -> List[Reason]:
    """Compute per-transaction ML_MODEL reason using XGBoost pred_contribs naming top 3 features with direction.

    If contributions cannot be computed (e.g. model load failure or missing booster),
    returns an empty list (omits reason, does not fabricate one).
    """
    if model is None or not hasattr(model, "get_booster"):
        return []
    try:
        booster = model.get_booster()
        vec = np.array([[features.get(f, 0.0) for f in FEATURE_NAMES]], dtype=np.float32)
        dmatrix = xgb.DMatrix(vec, feature_names=FEATURE_NAMES)
        contribs = booster.predict(dmatrix, pred_contribs=True)
        contrib_vals = contribs[0][:-1]
        top_idxs = np.argsort(-np.abs(contrib_vals))[:3]

        driver_parts: List[str] = []
        for idx in top_idxs:
            fname = FEATURE_NAMES[idx]
            fval = features.get(fname, 0.0)
            contrib = float(contrib_vals[idx])
            direction = "raises risk" if contrib > 0 else "lowers risk"
            label = FEATURE_LABELS.get(fname, fname)
            val_str = _format_feature_val(fname, fval)
            driver_parts.append(f"{label} ({val_str}) {direction}")

        detail = f"Top model drivers: {', '.join(driver_parts)}"
        weight = max(1, int(round(0.6 * ensemble_score)))
        return [
            Reason(
                rule="ML_MODEL",
                detail=detail,
                weight=weight,
            )
        ]
    except Exception:
        return []


def score_transaction(
    transaction: Transaction,
    state: Optional[EngineState] = None,
) -> ScoredTransaction:
    """Score a transaction within the 100ms budget blending rules and ML."""
    start_time = time.perf_counter()
    if state is None:
        state = GLOBAL_STATE

    # 1. Rule Engine Evaluation
    reasons: List[Reason] = evaluate(transaction, state=state)
    rule_score = score_from_reasons(reasons)

    # 2. ML Scoring with graceful fallback
    ring_id: Optional[str] = None
    graph_cache = GLOBAL_GRAPH.get_cache()
    model_scores: Optional[Dict[str, float]] = None
    final_score = rule_score

    if is_model_loaded() and GLOBAL_ENSEMBLE.is_loaded:
        try:
            features = extract_features(transaction, state=state, graph_cache=graph_cache)
            ensemble_score, model_scores, ensemble_reasons = GLOBAL_ENSEMBLE.score_transaction(
                features, rule_score, transaction, graph_cache=graph_cache
            )
            blended = int(round(0.4 * rule_score + 0.6 * ensemble_score))
            final_score = min(max(blended, 0), 100)

            # Per-transaction feature contributions using XGBoost pred_contribs
            xgb_reasons = _compute_xgb_reasons(GLOBAL_ENSEMBLE.supervised_model, features, ensemble_score=ensemble_score)
            reasons.extend(xgb_reasons)
            reasons.extend(ensemble_reasons)
        except Exception:
            final_score = rule_score
    elif is_model_loaded():
        try:
            features = extract_features(transaction, state=state, graph_cache=graph_cache)
            ml_prob = predict_proba(features)
            ml_score = int(round(ml_prob * 100))
            final_score = int(round(0.4 * rule_score + 0.6 * ml_score))
            final_score = min(max(final_score, 0), 100)
            xgb_reasons = _compute_xgb_reasons(GLOBAL_ML.model, features, ensemble_score=ml_score)
            reasons.extend(xgb_reasons)
        except Exception:
            final_score = rule_score

    # 3. Detect fraud ring from graph cache
    node_to_ring = graph_cache.get("node_to_ring", {})
    if transaction.sender_id in node_to_ring:
        ring_id = node_to_ring[transaction.sender_id]
    elif transaction.receiver_id in node_to_ring:
        ring_id = node_to_ring[transaction.receiver_id]
    elif transaction.sender_id in graph_cache.get("cycle_nodes", set()):
        ring_id = f"RING_{transaction.sender_id[:8]}"

    # Ingest into graph engine using rule_score for exact parity with training pipeline
    GLOBAL_GRAPH.add_transaction(transaction, risk=rule_score / 100.0)

    # 4. Decision thresholds (calibrated or defaults 40/70)
    thresh_review = getattr(GLOBAL_ENSEMBLE, "thresholds", {}).get("review", 40)
    thresh_block = getattr(GLOBAL_ENSEMBLE, "thresholds", {}).get("block", 70)

    if final_score >= thresh_block:
        decision = "BLOCK"
    elif final_score >= thresh_review:
        decision = "REVIEW"
    else:
        decision = "ALLOW"

    latency_ms = (time.perf_counter() - start_time) * 1000.0

    scored = ScoredTransaction(
        txn_id=transaction.txn_id,
        timestamp=transaction.timestamp,
        sender_id=transaction.sender_id,
        receiver_id=transaction.receiver_id,
        amount=transaction.amount,
        risk_score=final_score,
        decision=decision,
        reasons=reasons,
        ring_id=ring_id,
        latency_ms=round(latency_ms, 3),
        model_scores=model_scores,
    )
    METRICS.update(scored)
    return scored
