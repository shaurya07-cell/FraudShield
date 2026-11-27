"""Scorer coordinating rules, graph cache, and ML scoring."""
import time
import numpy as np
from typing import Dict, List, Optional

from app.graph_engine import GLOBAL_GRAPH
from app.metrics import METRICS
from app.ml import extract_features, get_top_feature, is_model_loaded, predict_proba, FEATURE_NAMES
from app.models_ensemble import GLOBAL_ENSEMBLE
from app.rules import evaluate, score_from_reasons
from app.schemas import Reason, ScoredTransaction, Transaction
from app.state import GLOBAL_STATE, EngineState


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
                features, rule_score, transaction
            )
            blended = int(round(0.4 * rule_score + 0.6 * ensemble_score))
            final_score = min(max(blended, 0), 100)
            top_feature = get_top_feature(features)
            meta_score = model_scores.get("meta", ensemble_score / 100.0) if model_scores else (ensemble_score / 100.0)
            reasons.append(
                Reason(
                    rule="ML_MODEL",
                    detail=f"Ensemble meta-score: {meta_score:.1%}, top driver: {top_feature}",
                    weight=int(round(0.6 * ensemble_score)),
                )
            )
            # SHAP-like contributions for supervised model
            if GLOBAL_ENSEMBLE.supervised_model is not None:
                try:
                    vec = np.array([[features.get(f, 0.0) for f in FEATURE_NAMES]], dtype=np.float32)
                    if hasattr(GLOBAL_ENSEMBLE.supervised_model, "get_booster"):
                        contribs = GLOBAL_ENSEMBLE.supervised_model.get_booster().predict(vec, pred_contribs=True)
                        contrib_vals = contribs[0][:-1]
                    else:
                        contrib_vals = np.array([GLOBAL_ENSEMBLE.supervised_model.feature_importances_] * len(FEATURE_NAMES))[0]
                    top_idxs = np.argsort(-np.abs(contrib_vals))[:2]
                    for idx in top_idxs:
                        fname = FEATURE_NAMES[idx]
                        fvalue = features.get(fname, 0.0)
                        reasons.append(
                            Reason(
                                rule="FEATURE_XGBOOST",
                                detail=f"Feature '{fname}' (value {fvalue:.2f}) contributes to risk",
                                weight=1,
                            )
                        )
                except Exception:
                    pass
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
            top_feature = get_top_feature(features)
            reasons.append(
                Reason(
                    rule="ML_MODEL",
                    detail=f"Predicted risk: {ml_prob:.1%}, top driver: {top_feature}",
                    weight=int(round(0.6 * ml_score)),
                )
            )
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

    # Ingest into graph engine
    GLOBAL_GRAPH.add_transaction(transaction, risk=final_score / 100.0)

    # 4. Decision thresholds
    if final_score >= 70:
        decision = "BLOCK"
    elif final_score >= 40:
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
