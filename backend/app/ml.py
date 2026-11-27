"""Machine Learning scoring module for FraudShield."""
import math
import os
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np

from app.graph_engine import GLOBAL_GRAPH
from app.schemas import Transaction
from app.state import EngineState, GLOBAL_STATE, parse_timestamp

FEATURE_NAMES: List[str] = [
    "amount",
    "amount_ratio_to_sender_avg",
    "sender_txn_count_1m",
    "sender_txn_count_5m",
    "sender_account_age_seconds",
    "sender_distinct_receivers_5m",
    "receiver_distinct_senders_5m",
    "device_shared_accounts",
    "is_round_trip",
    "sender_in_degree",
    "sender_out_degree",
    "receiver_in_degree",
    "receiver_out_degree",
    "sender_pagerank",
    "receiver_pagerank",
    "sender_clustering",
    "in_cycle",
    "component_size",
    "neighbor_avg_risk",
]

DEFAULT_MODEL_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "models", "fraud_model.joblib")
)


def extract_features(
    txn: Transaction,
    state: Optional[EngineState] = None,
    graph_cache: Optional[Dict[str, Any]] = None,
) -> Dict[str, float]:
    """Extract 19 numerical fraud indicators from transaction, state, and graph cache.

    Guarantees all values are finite float numbers with no NaNs.
    """
    if state is None:
        state = GLOBAL_STATE
    if graph_cache is None:
        graph_cache = GLOBAL_GRAPH.get_cache()

    current_time = parse_timestamp(txn.timestamp)

    with state._lock:
        sender_acc = state.accounts.get(txn.sender_id)
        receiver_acc = state.accounts.get(txn.receiver_id)

        # 1. Transaction Amount
        amount = float(txn.amount)

        # 2. Ratio to sender running average
        if sender_acc is not None and sender_acc.running_avg > 0.0:
            amount_ratio = amount / sender_acc.running_avg
        else:
            amount_ratio = 1.0

        # 3 & 4. Transaction velocity (1m = 60s, 5m = 300s)
        cutoff_60s = current_time - 60.0
        cutoff_300s = current_time - 300.0
        count_1m = 1
        count_5m = 1

        if sender_acc is not None:
            for t_stamp, _ in reversed(sender_acc.sent_window):
                if t_stamp >= cutoff_60s:
                    count_1m += 1
                if t_stamp >= cutoff_300s:
                    count_5m += 1
                else:
                    break

        # 5. Account age in seconds
        first_seen = sender_acc.first_seen if sender_acc is not None else current_time
        account_age = max(0.0, current_time - first_seen)

        # 6. Distinct receivers sender sent to in last 5m
        receivers_5m = {txn.receiver_id}
        sender_pairs = state.pair_graph.get(txn.sender_id, {})
        for rec_id, last_t in sender_pairs.items():
            if last_t >= cutoff_300s:
                receivers_5m.add(rec_id)
        sender_distinct_receivers_5m = float(len(receivers_5m))

        # 7. Distinct senders receiver received from in last 5m
        senders_5m = {txn.sender_id}
        if receiver_acc is not None:
            for t_stamp, s_id in reversed(receiver_acc.received_window):
                if t_stamp >= cutoff_300s:
                    senders_5m.add(s_id)
                else:
                    break
        receiver_distinct_senders_5m = float(len(senders_5m))

        # 8. Device collisions
        device_users = state.device_accounts.get(txn.device_id, set())
        device_shared_accounts = float(len(device_users | {txn.sender_id}))

        # 9. Immediate round trip or short cycle check
        is_round_trip = 1.0 if state.check_round_trip(txn.sender_id, txn.receiver_id, current_time) else 0.0

    # 10 - 19. Graph topological metrics from cache
    in_deg = graph_cache.get("in_degree", {})
    out_deg = graph_cache.get("out_degree", {})
    pr = graph_cache.get("pagerank", {})
    clustering = graph_cache.get("clustering", {})
    cycle_nodes = graph_cache.get("cycle_nodes", set())
    comp_size = graph_cache.get("component_size", {})
    nbr_risk = graph_cache.get("neighbor_avg_risk", {})

    sender_in_degree = float(in_deg.get(txn.sender_id, 0))
    sender_out_degree = float(out_deg.get(txn.sender_id, 0))
    receiver_in_degree = float(in_deg.get(txn.receiver_id, 0))
    receiver_out_degree = float(out_deg.get(txn.receiver_id, 0))

    sender_pagerank = float(pr.get(txn.sender_id, 0.0))
    receiver_pagerank = float(pr.get(txn.receiver_id, 0.0))
    sender_clustering = float(clustering.get(txn.sender_id, 0.0))

    in_cycle = 1.0 if (txn.sender_id in cycle_nodes or txn.receiver_id in cycle_nodes) else 0.0
    component_size = float(comp_size.get(txn.sender_id, 1))
    neighbor_avg_risk = float(nbr_risk.get(txn.sender_id, 0.0))

    features: Dict[str, float] = {
        "amount": amount,
        "amount_ratio_to_sender_avg": amount_ratio,
        "sender_txn_count_1m": float(count_1m),
        "sender_txn_count_5m": float(count_5m),
        "sender_account_age_seconds": account_age,
        "sender_distinct_receivers_5m": sender_distinct_receivers_5m,
        "receiver_distinct_senders_5m": receiver_distinct_senders_5m,
        "device_shared_accounts": device_shared_accounts,
        "is_round_trip": is_round_trip,
        "sender_in_degree": sender_in_degree,
        "sender_out_degree": sender_out_degree,
        "receiver_in_degree": receiver_in_degree,
        "receiver_out_degree": receiver_out_degree,
        "sender_pagerank": sender_pagerank,
        "receiver_pagerank": receiver_pagerank,
        "sender_clustering": sender_clustering,
        "in_cycle": in_cycle,
        "component_size": component_size,
        "neighbor_avg_risk": neighbor_avg_risk,
    }

    # Safety: guarantee no NaN or Infinite values
    for k, v in features.items():
        if math.isnan(v) or math.isinf(v):
            features[k] = 0.0

    return features


class FraudMLModel:
    """Manages model loading, fast inference, and explainability."""

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH):
        self.model_path: str = model_path
        self.model: Any = None
        self.feature_names: List[str] = FEATURE_NAMES
        self.feature_importances: Optional[np.ndarray] = None
        self.load()

    def load(self, path: Optional[str] = None) -> bool:
        """Load trained model and feature definitions from disk."""
        target_path = path or self.model_path
        if not os.path.exists(target_path):
            self.model = None
            return False

        try:
            artifact = joblib.load(target_path)
            if isinstance(artifact, dict) and "model" in artifact:
                self.model = artifact["model"]
                self.feature_names = artifact.get("feature_names", FEATURE_NAMES)
            else:
                self.model = artifact
                self.feature_names = FEATURE_NAMES

            if hasattr(self.model, "feature_importances_"):
                self.feature_importances = np.array(self.model.feature_importances_)
            else:
                self.feature_importances = None
            return True
        except Exception:
            self.model = None
            return False

    @property
    def is_loaded(self) -> bool:
        return self.model is not None

    def predict_proba(self, features: Dict[str, float]) -> float:
        """Predict fraud probability in under 2 ms.

        Returns float probability in [0.0, 1.0]. Returns 0.0 if model is not loaded.
        """
        if self.model is None:
            return 0.0

        # Construct contiguous row array in exact feature order
        row = np.array(
            [[features.get(name, 0.0) for name in self.feature_names]],
            dtype=np.float32,
        )

        try:
            # XGBoost or Scikit-learn Classifier
            if hasattr(self.model, "predict_proba"):
                probs = self.model.predict_proba(row)
                return float(probs[0, 1])
            elif hasattr(self.model, "predict"):
                preds = self.model.predict(row)
                return float(preds[0])
            return 0.0
        except Exception:
            return 0.0

    def get_top_feature(self, features: Dict[str, float]) -> str:
        """Identify top contributing feature for model explainability."""
        if not self.feature_names:
            return "amount"

        if self.feature_importances is not None and len(self.feature_importances) == len(self.feature_names):
            # Rank by (feature_importance * normalized_feature_presence)
            scores = []
            for i, name in enumerate(self.feature_names):
                val = abs(features.get(name, 0.0))
                # Add log scaling so large amounts don't artificially dominate
                scaled_val = math.log1p(val) if val > 0 else 0.0
                score = self.feature_importances[i] * (1.0 + scaled_val)
                scores.append((score, name))
            scores.sort(reverse=True)
            return scores[0][1]

        # Fallback to feature with largest magnitude
        return max(self.feature_names, key=lambda n: abs(features.get(n, 0.0)))


# Global ML model instance initialized at startup
GLOBAL_ML = FraudMLModel()


def is_model_loaded() -> bool:
    """Check if ML model is active."""
    return GLOBAL_ML.is_loaded


def predict_proba(features: Dict[str, float]) -> float:
    """Predict fraud probability from feature dict."""
    return GLOBAL_ML.predict_proba(features)


def get_top_feature(features: Dict[str, float]) -> str:
    """Get the name of the feature driving the model decision."""
    return GLOBAL_ML.get_top_feature(features)


def predict_risk(transaction: Transaction) -> float:
    """Predict risk score using in-memory model and state lookups."""
    feats = extract_features(transaction)
    return predict_proba(feats)
