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

import joblib
import numpy as np

from app.ml import get_models_dir
from app.schemas import Reason, Transaction

MODELS_DIR = get_models_dir()

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

MULE_FEATURES: List[str] = [
    "pass_through_ratio",
    "avg_gap_seconds",
    "distinct_counterparties",
    "account_age_seconds",
    "in_degree",
    "out_degree",
    "round_amount_share",
]

META_FEATURE_NAMES: List[str] = [
    "score_supervised",
    "score_anomaly",
    "score_profile",
    "score_graph",
    "score_device",
    "rule_score_norm",
]

META_FEATURE_NAMES_V3: List[str] = [
    "score_supervised",
    "score_anomaly",
    "score_profile",
    "score_graph",
    "score_device",
    "score_mule",
    "rule_score_norm",
]


class MuleAccountTracker:
    """Tracks account-level inflows, outflows, timing, and counterparty diversity online.

    Enables computing mule account features at the exact transaction moment without future lookahead:
    - pass_through_ratio: recent money received then sent onward within a 60m sliding window
    - avg_gap_seconds: time difference between receive and send
    - distinct_counterparties: unique senders + receivers
    - account_age_seconds: account age
    - in_degree / out_degree: topological flow counts
    - round_amount_share: fraction of transactions with round amounts (multiple of 100 or 500)
    """

    def __init__(self):
        # account_id -> {first_seen, in_txns: list[(time, amt, sender)], out_txns: list[(time, amt, rec)], counterparties: set, round_count, total_count}
        self.accounts: Dict[str, Dict[str, Any]] = {}

    def update_transaction(self, txn: Transaction, current_time: float) -> None:
        """Update account history for sender and receiver."""
        amt = float(txn.amount)
        is_round = 1 if (int(amt) % 100 == 0 or int(amt) % 500 == 0) else 0

        # Update sender
        if txn.sender_id not in self.accounts:
            self.accounts[txn.sender_id] = {
                "first_seen": current_time,
                "in_txns": [],
                "out_txns": [],
                "counterparties": {txn.receiver_id},
                "round_count": is_round,
                "total_count": 1,
            }
        else:
            acc = self.accounts[txn.sender_id]
            acc["counterparties"].add(txn.receiver_id)
            acc["round_count"] += is_round
            acc["total_count"] += 1
        self.accounts[txn.sender_id]["out_txns"].append((current_time, amt, txn.receiver_id))

        # Update receiver
        if txn.receiver_id not in self.accounts:
            self.accounts[txn.receiver_id] = {
                "first_seen": current_time,
                "in_txns": [],
                "out_txns": [],
                "counterparties": {txn.sender_id},
                "round_count": is_round,
                "total_count": 1,
            }
        else:
            acc = self.accounts[txn.receiver_id]
            acc["counterparties"].add(txn.sender_id)
            acc["round_count"] += is_round
            acc["total_count"] += 1
        self.accounts[txn.receiver_id]["in_txns"].append((current_time, amt, txn.sender_id))

    def extract_mule_features(
        self,
        account_id: str,
        amount: float,
        current_time: float,
        graph_cache: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, float]:
        """Compute the 7 mule features at the exact transaction moment."""
        acc = self.accounts.get(account_id)
        if not acc:
            return {
                "pass_through_ratio": 0.0,
                "avg_gap_seconds": 3600.0,
                "distinct_counterparties": 1.0,
                "account_age_seconds": 0.0,
                "in_degree": 0.0,
                "out_degree": 0.0,
                "round_amount_share": 1.0 if (int(amount) % 100 == 0) else 0.0,
            }

        first_seen = acc.get("first_seen", current_time)
        age = max(0.0, current_time - first_seen)

        # Sliding window 3600s (1 hour)
        cutoff = current_time - 3600.0
        recent_in = [amt for t, amt, _ in acc["in_txns"] if t >= cutoff]
        recent_out = [amt for t, amt, _ in acc["out_txns"] if t >= cutoff]

        total_in = sum(recent_in)
        total_out = sum(recent_out) + amount  # include current outflow

        # Pass-through ratio: how much of the received money is being rapidly routed out
        if total_in > 0:
            pass_through = min(1.0, total_out / (total_in + 1e-5))
        else:
            pass_through = 0.0

        # Time gap between most recent receive and this send
        gaps = []
        if acc["in_txns"]:
            last_in_time = acc["in_txns"][-1][0]
            gaps.append(max(0.0, current_time - last_in_time))
        avg_gap = float(np.mean(gaps)) if gaps else 3600.0

        distinct_cp = float(len(acc["counterparties"]))

        # Degrees from graph cache or local transactions
        in_deg = 0.0
        out_deg = 0.0
        if graph_cache:
            in_deg = float(graph_cache.get("in_degree", {}).get(account_id, len(acc["in_txns"])))
            out_deg = float(graph_cache.get("out_degree", {}).get(account_id, len(acc["out_txns"])))
        else:
            in_deg = float(len(acc["in_txns"]))
            out_deg = float(len(acc["out_txns"]))

        tot_tx = max(1, acc["total_count"])
        round_share = float(acc["round_count"]) / tot_tx

        return {
            "pass_through_ratio": round(pass_through, 4),
            "avg_gap_seconds": round(avg_gap, 2),
            "distinct_counterparties": distinct_cp,
            "account_age_seconds": round(age, 2),
            "in_degree": in_deg,
            "out_degree": out_deg,
            "round_amount_share": round(round_share, 4),
        }


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
        self.mule_model: Optional[Any] = None
        self.mule_tracker: MuleAccountTracker = MuleAccountTracker()
        self.meta_model: Optional[Any] = None
        self.thresholds: Dict[str, int] = {"review": 40, "block": 70}
        self.load_models()

    def load_models(self) -> None:
        """Load all model artifacts and thresholds from disk with graceful per-model fallback."""
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

        # 6. Mule Model
        self.mule_model = _load("mule_model.joblib")

        # 7. Meta Model
        self.meta_model = _load("meta_model.joblib")

        # Load calibrated thresholds if saved with model
        thresh_path = os.path.join(self.models_dir, "thresholds.json")
        if os.path.exists(thresh_path):
            try:
                import json
                with open(thresh_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.thresholds = {
                        "review": int(data.get("review_threshold", 40)),
                        "block": int(data.get("block_threshold", 70)),
                    }
            except Exception:
                self.thresholds = {"review": 40, "block": 70}
        else:
            self.thresholds = {"review": 40, "block": 70}

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

    def predict_mule(
        self,
        account_id: str,
        amount: float,
        current_time: float,
        graph_cache: Optional[Dict[str, Any]] = None,
    ) -> float:
        """Score from Mule-Account specialist model."""
        if self.mule_model is None:
            return 0.0
        try:
            mule_feats = self.mule_tracker.extract_mule_features(
                account_id=account_id,
                amount=amount,
                current_time=current_time,
                graph_cache=graph_cache,
            )
            vec = np.array([[mule_feats.get(f, 0.0) for f in MULE_FEATURES]], dtype=np.float32)
            if hasattr(self.mule_model, "predict_proba"):
                probs = self.mule_model.predict_proba(vec)
                return float(probs[0, 1])
            elif hasattr(self.mule_model, "predict"):
                return float(self.mule_model.predict(vec)[0])
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
        score_mule: Optional[float] = None,
    ) -> float:
        """Calibrated Meta-Model combining all specialist predictions and rule signal."""
        rule_norm = float(rule_score) / 100.0
        mule_val = 0.0 if score_mule is None else score_mule

        if self.meta_model is not None:
            try:
                # Support both 7-feature (v3) and legacy 6-feature (v1/v2) meta models
                n_in = getattr(self.meta_model, "n_features_in_", 6)
                if n_in == 6:
                    meta_vec = np.array(
                        [[score_sup, score_anom, score_prof, score_graph, score_dev, rule_norm]],
                        dtype=np.float32,
                    )
                else:
                    meta_vec = np.array(
                        [[score_sup, score_anom, score_prof, score_graph, score_dev, mule_val, rule_norm]],
                        dtype=np.float32,
                    )
                if hasattr(self.meta_model, "predict_proba"):
                    probs = self.meta_model.predict_proba(meta_vec)
                    return float(probs[0, 1])
                elif hasattr(self.meta_model, "predict"):
                    return float(self.meta_model.predict(meta_vec)[0])
            except Exception:
                pass

        # Graceful fallback: weighted heuristic fusion
        weighted = (
            0.30 * score_sup
            + 0.10 * score_anom
            + 0.10 * score_prof
            + 0.20 * score_graph
            + 0.10 * score_dev
            + 0.10 * mule_val
            + 0.10 * rule_norm
        )
        return float(np.clip(weighted, 0.0, 1.0))

    def score_transaction(
        self,
        features: Dict[str, float],
        rule_score: int,
        transaction: Transaction,
        current_time: Optional[float] = None,
        graph_cache: Optional[Dict[str, Any]] = None,
    ) -> Tuple[int, Dict[str, float], List[Reason]]:
        """Score transaction through ensemble, returning final score, per-model breakdown, and reasons."""
        if current_time is None:
            from app.state import parse_timestamp
            current_time = parse_timestamp(transaction.timestamp)

        s_sup = self.predict_supervised(features)
        s_anom = self.predict_anomaly(features)
        s_prof = self.predict_profile(transaction)
        s_graph = self.predict_graph(features)
        s_dev = self.predict_device(features)
        s_mule = self.predict_mule(
            account_id=transaction.sender_id,
            amount=float(transaction.amount),
            current_time=current_time,
            graph_cache=graph_cache,
        )

        meta_prob = self.predict_meta(
            score_sup=s_sup,
            score_anom=s_anom,
            score_prof=s_prof,
            score_graph=s_graph,
            score_dev=s_dev,
            score_mule=s_mule,
            rule_score=rule_score,
        )

        final_risk_score = int(round(meta_prob * 100.0))
        final_risk_score = min(max(final_risk_score, 0), 100)

        # Update profile tracker & mule tracker
        self.profile_model.update_account(
            account_id=transaction.sender_id,
            amount=float(transaction.amount),
            receiver_id=transaction.receiver_id,
        )
        self.mule_tracker.update_transaction(transaction, current_time)

        model_scores = {
            "supervised": round(s_sup, 3),
            "anomaly": round(s_anom, 3),
            "profile": round(s_prof, 3),
            "graph": round(s_graph, 3),
            "device": round(s_dev, 3),
            "mule": round(s_mule, 3),
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
        if s_mule >= 0.50:
            reasons.append(
                Reason(
                    rule="MODEL_MULE",
                    detail=f"Mule account behavior: rapid fund pass-through and abnormal counterparty turnover (score {s_mule:.2f})",
                    weight=int(round(s_mule * 25)),
                )
            )

        return final_risk_score, model_scores, reasons


# Global ensemble singleton
GLOBAL_ENSEMBLE = FraudEnsemble()
