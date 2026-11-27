"""FraudShield Multi-Model Ensemble Architecture.

Comprises five specialist fraud models plus a calibrated meta-model:
1. SupervisedClassifier: XGBoost on behavioral, velocity, and topological graph features.
2. AnomalyDetector: Isolation Forest on behavioral and velocity features.
3. BehaviourProfileModel: Per-account historical baselines (amount z-scores, familiar receivers, cold-start).
4. GraphFraudModel: NetworkX / GraphEngine topological metrics (degrees, PageRank, clustering, cycle, neighbor risk).
5. DeviceIdentityModel: Shared device & collision cluster classifier.
6. MetaEnsembleModel: Calibrated meta-learner fusing specialist predictions and rule engine score.
"""
import math
import os
from typing import Any, Dict, List, Optional, Tuple
import warnings

from . import joblib
import numpy as np

from app.schemas import Reason, Transaction

MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))

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

ANOMALY_FEATURES: List[str] = [
    "amount",
    "amount_ratio_to_sender_avg",
    "sender_txn_count_1m",
    "sender_txn_count_5m",
    "sender_account_age_seconds",
    "sender_distinct_receivers_5m",
    "receiver_distinct_senders_5m",
]

GRAPH_FEATURES: List[str] = [
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

DEVICE_FEATURES: List[str] = [
    "device_shared_accounts",
    "sender_distinct_receivers_5m",
    "receiver_distinct_senders_5m",
    "is_round_trip",
]

META_FEATURE_NAMES: List[str] = [
    "score_supervised",
    "score_anomaly",
    "score_profile",
    "score_graph",
    "score_device",
    "rule_score_norm",
]


class BehaviourProfileModel:
    """Tracks per-account spending statistics online to evaluate individual profile deviation."""

    def __init__(self):
        # account_id -> {count, mean, M2 (for Welford's algorithm), receivers: set}
        self.profiles: Dict[str, Dict[str, Any]] = {}

    def update_account(self, account_id: str, amount: float, receiver_id: str) -> None:
        """Online Welford update of amount running mean and variance."""
        if account_id not in self.profiles:
            self.profiles[account_id] = {
                "count": 1,
                "mean": float(amount),
                "M2": 0.0,
                "receivers": {receiver_id},
            }
            return

        prof = self.profiles[account_id]
        prof["count"] += 1
        prof["receivers"].add(receiver_id)
        delta = amount - prof["mean"]
        prof["mean"] += delta / prof["count"]
        delta2 = amount - prof["mean"]
        prof["M2"] += delta * delta2

    def predict_score(self, account_id: str, amount: float, receiver_id: str) -> float:
        """Compute deviation score [0.0, 1.0] from account's own history with cold-start handling."""
        prof = self.profiles.get(account_id)
        # Cold start: fewer than 3 historical transactions
        if not prof or prof["count"] < 3:
            return 0.15

        variance = prof["M2"] / (prof["count"] - 1) if prof["count"] > 1 else 1000.0
        mean = prof["mean"]
        min_std = max(mean * 0.15, 20.0)
        std = math.sqrt(max(variance, min_std ** 2))

        # Z-score of transaction amount
        z_score = abs(amount - mean) / std
        z_norm = min(1.0, z_score / 4.0)

        # Receiver novelty
        is_novel_receiver = 1.0 if receiver_id not in prof["receivers"] else 0.0

        # Frequency factor
        combined = 0.65 * z_norm + 0.35 * is_novel_receiver
        return float(np.clip(combined, 0.0, 1.0))


class FraudEnsemble:
    """Coordinates specialist models and meta-model inference with robust fallbacks."""

    def __init__(self, models_dir: Optional[str] = None):
        self.models_dir = models_dir or MODELS_DIR
        self.supervised_model: Optional[Any] = None
        self.anomaly_model: Optional[Any] = None
        self.profile_model: BehaviourProfileModel = BehaviourProfileModel()
        self.graph_model: Optional[Any] = None
        self.device_model: Optional[Any] = None
        self.meta_model: Optional[Any] = None
        self.load_models()

    def load_models(self) -> None:
        """Load all model artifacts from disk with graceful per-model fallback."""
        def _load(filename: str):
            path = os.path.join(self.models_dir, filename)
            if os.path.exists(path):
                try:
                    return joblib.load(path)
                except Exception:
                    return None
            return None

        # 1. Supervised XGBoost
        self.supervised_model = _load("supervised_xgb.joblib") or _load("fraud_model.joblib")

        # 2. Anomaly Isolation Forest
        self.anomaly_model = _load("anomaly_iforest.joblib")

        # 3. Behaviour Profile
        prof = _load("behaviour_profile.joblib")
        if prof is not None and isinstance(prof, BehaviourProfileModel):
            self.profile_model = prof

        # 4. Graph Model
        self.graph_model = _load("graph_model.joblib")

        # 5. Device Identity Model
        self.device_model = _load("device_identity_model.joblib")

        # 6. Meta Model
        self.meta_model = _load("meta_model.joblib")

    @property
    def is_loaded(self) -> bool:
        """Check if at least the primary supervised model or meta model is available."""
        return self.supervised_model is not None or self.meta_model is not None

    def predict_supervised(self, features: Dict[str, float]) -> float:
        """Score from Supervised XGBoost model."""
        if self.supervised_model is None:
            return 0.0
        try:
            vec = np.array([[features.get(f, 0.0) for f in FEATURE_NAMES]], dtype=np.float32)
            if hasattr(self.supervised_model, "predict_proba"):
                probs = self.supervised_model.predict_proba(vec)
                return float(probs[0, 1])
            elif hasattr(self.supervised_model, "predict"):
                return float(self.supervised_model.predict(vec)[0])
        except Exception:
            return 0.0
        return 0.0

    def predict_anomaly(self, features: Dict[str, float]) -> float:
        """Score from Isolation Forest anomaly detector, mapped to [0.0, 1.0]."""
        if self.anomaly_model is None:
            return 0.0
        try:
            vec = np.array([[features.get(f, 0.0) for f in ANOMALY_FEATURES]], dtype=np.float32)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                score_raw = float(self.anomaly_model.decision_function(vec)[0])
            # Sigmoid mapping centered near 0.0: lower score_raw -> higher anomaly probability
            prob = 1.0 / (1.0 + math.exp(score_raw * 10.0))
            return float(np.clip(prob, 0.0, 1.0))
        except Exception:
            return 0.0

    def predict_profile(self, txn: Transaction) -> float:
        """Score from Behaviour Profile model."""
        try:
            return self.profile_model.predict_score(
                account_id=txn.sender_id,
                amount=float(txn.amount),
                receiver_id=txn.receiver_id,
            )
        except Exception:
            return 0.1

    def predict_graph(self, features: Dict[str, float]) -> float:
        """Score from Graph topological specialist model."""
        if self.graph_model is None:
            return 0.0
        try:
            vec = np.array([[features.get(f, 0.0) for f in GRAPH_FEATURES]], dtype=np.float32)
            if hasattr(self.graph_model, "predict_proba"):
                probs = self.graph_model.predict_proba(vec)
                return float(probs[0, 1])
            elif hasattr(self.graph_model, "predict"):
                return float(self.graph_model.predict(vec)[0])
        except Exception:
            return 0.0
        return 0.0

    def predict_device(self, features: Dict[str, float]) -> float:
        """Score from Device and Identity specialist model."""
        if self.device_model is None:
            return 0.0
        try:
            vec = np.array([[features.get(f, 0.0) for f in DEVICE_FEATURES]], dtype=np.float32)
            if hasattr(self.device_model, "predict_proba"):
                probs = self.device_model.predict_proba(vec)
                return float(probs[0, 1])
            elif hasattr(self.device_model, "predict"):
                return float(self.device_model.predict(vec)[0])
        except Exception:
            return 0.0
        return 0.0

    def predict_meta(
        self,
        score_sup: float,
        score_anom: float,
        score_prof: float,
        score_graph: float,
        score_dev: float,
        rule_score: int,
    ) -> float:
        """Calibrated Meta-Model combining all specialist predictions and rule signal."""
        rule_norm = float(rule_score) / 100.0

        if self.meta_model is not None:
            try:
                meta_vec = np.array(
                    [[score_sup, score_anom, score_prof, score_graph, score_dev, rule_norm]],
                    dtype=np.float32,
                )
                if hasattr(self.meta_model, "predict_proba"):
                    probs = self.meta_model.predict_proba(meta_vec)
                    return float(probs[0, 1])
                elif hasattr(self.meta_model, "predict"):
                    return float(self.meta_model.predict(meta_vec)[0])
            except Exception:
                pass

        # Graceful fallback: weighted heuristic fusion if meta model is unavailable
        weighted = (
            0.35 * score_sup
            + 0.15 * score_anom
            + 0.10 * score_prof
            + 0.20 * score_graph
            + 0.10 * score_dev
            + 0.10 * rule_norm
        )
        return float(np.clip(weighted, 0.0, 1.0))

    def score_transaction(
        self,
        features: Dict[str, float],
        rule_score: int,
        transaction: Transaction,
    ) -> Tuple[int, Dict[str, float], List[Reason]]:
        """Score transaction through ensemble, returning final score, per-model breakdown, and reasons."""
        s_sup = self.predict_supervised(features)
        s_anom = self.predict_anomaly(features)
        s_prof = self.predict_profile(transaction)
        s_graph = self.predict_graph(features)
        s_dev = self.predict_device(features)

        meta_prob = self.predict_meta(
            score_sup=s_sup,
            score_anom=s_anom,
            score_prof=s_prof,
            score_graph=s_graph,
            score_dev=s_dev,
            rule_score=rule_score,
        )

        final_risk_score = int(round(meta_prob * 100.0))
        final_risk_score = min(max(final_risk_score, 0), 100)

        # Update profile tracker
        self.profile_model.update_account(
            account_id=transaction.sender_id,
            amount=float(transaction.amount),
            receiver_id=transaction.receiver_id,
        )

        model_scores = {
            "supervised": round(s_sup, 3),
            "anomaly": round(s_anom, 3),
            "profile": round(s_prof, 3),
            "graph": round(s_graph, 3),
            "device": round(s_dev, 3),
            "meta": round(meta_prob, 3),
        }

        # Generate explainable reasons for models that contributed meaningfully
        reasons: List[Reason] = []
        if s_sup >= 0.40:
            reasons.append(
                Reason(
                    rule="MODEL_SUPERVISED",
                    detail=f"Supervised fraud model flagged behavioral pattern (score {s_sup:.2f})",
                    weight=int(round(s_sup * 30)),
                )
            )
        if s_anom >= 0.45:
            reasons.append(
                Reason(
                    rule="MODEL_ANOMALY",
                    detail=f"Isolation forest flagged statistical transaction anomaly (score {s_anom:.2f})",
                    weight=int(round(s_anom * 20)),
                )
            )
        if s_prof >= 0.50:
            reasons.append(
                Reason(
                    rule="MODEL_PROFILE",
                    detail=f"Unusual for this account history (score {s_prof:.2f})",
                    weight=int(round(s_prof * 20)),
                )
            )
        if s_graph >= 0.40:
            reasons.append(
                Reason(
                    rule="MODEL_GRAPH",
                    detail=f"Account situated in high-risk transaction cluster (score {s_graph:.2f})",
                    weight=int(round(s_graph * 25)),
                )
            )
        if s_dev >= 0.40:
            reasons.append(
                Reason(
                    rule="MODEL_DEVICE",
                    detail=f"Device or IP collision risk detected (score {s_dev:.2f})",
                    weight=int(round(s_dev * 25)),
                )
            )

        return final_risk_score, model_scores, reasons


# Global ensemble singleton
GLOBAL_ENSEMBLE = FraudEnsemble()
