"""Scorer coordinating rules, graph cache, and ML scoring."""
import time
from typing import List, Optional

from app.graph_engine import GLOBAL_GRAPH
from app.metrics import METRICS
from app.ml import extract_features, get_top_feature, is_model_loaded, predict_proba
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

    if is_model_loaded():
        try:
            features = extract_features(transaction, state=state, graph_cache=graph_cache)
            ml_prob = predict_proba(features)
            ml_score = int(round(ml_prob * 100))

            # Blended Score: 40% rules + 60% ML
            final_score = int(round(0.4 * rule_score + 0.6 * ml_score))
            final_score = min(max(final_score, 0), 100)

            # Detail with top contributing feature
            top_feature = get_top_feature(features)
            ml_weight = int(round(0.6 * ml_score))
            reasons.append(
                Reason(
                    rule="ML_MODEL",
                    detail=f"Predicted risk: {ml_prob:.1%}, top driver: {top_feature}",
                    weight=ml_weight,
                )
            )
        except Exception:
            # Fallback gracefully to rules only
            final_score = rule_score
    else:
        final_score = rule_score

    # Check for detected fraud ring from graph cache
    node_to_ring = graph_cache.get("node_to_ring", {})
    if transaction.sender_id in node_to_ring:
        ring_id = node_to_ring[transaction.sender_id]
    elif transaction.receiver_id in node_to_ring:
        ring_id = node_to_ring[transaction.receiver_id]
    elif transaction.sender_id in graph_cache.get("cycle_nodes", set()):
        ring_id = f"RING_{transaction.sender_id[:8]}"

    # Ingest into graph engine
    GLOBAL_GRAPH.add_transaction(transaction, risk=final_score / 100.0)

    # 3. Decision Thresholds (ALLOW: 0-39, REVIEW: 40-69, BLOCK: 70-100)
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
    )

    # Update metrics in-memory collector (O(1), no I/O)
    METRICS.update(scored)

    return scored
