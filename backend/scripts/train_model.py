"""Model training pipeline for FraudShield with realistic noise and zero leakage.

Generates realistic noisy payment streams (~50k txns) with:
- No separate ID range for fraud (mixed across all accounts, compromised honest accounts)
- Hard negatives: high fan-in merchants, family shared devices, salary bursts, bill splits, amount spikes
- Hard positives: ~15% stealth fraud (normal amounts/pace), unshared device rings, varied delays
- Replay in time order through EngineState and GraphEngine
- Evaluation of Rules Only, ML Only, and Blended (40% rules + 60% ML)
- Generation of ml_report.json, feature_importance.png, and roc_curve.png
"""
import datetime
import json
import math
import os
import random
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

import joblib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import (
    auc,
    confusion_matrix,
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
import xgboost as xgb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.graph_engine import GraphEngine
from app.ml import FEATURE_NAMES, extract_features
from app.rules import evaluate, score_from_reasons
from app.schemas import Transaction
from app.simulator import (
    ALL_ACCOUNTS,
    EMPLOYER_ACCOUNTS,
    FAMILY_DEVICES,
    FRAUD_TXN_IDS,
    HONEST_ACCOUNTS,
    MERCHANT_ACCOUNTS,
    _ip_from_account,
)
from app.state import EngineState

MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
DOCS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "docs"))
os.makedirs(MODELS_DIR, exist_ok=True)
os.makedirs(DOCS_DIR, exist_ok=True)


def generate_realistic_dataset(
    target_count: int = 50_000,
) -> Tuple[List[Transaction], Set[str]]:
    """Generate ~50,000 transactions with realistic hard negatives and hard positives."""
    print(f"Synthesizing ~{target_count:,} realistic transactions with noise & hard edge-cases...")
    random.seed(42)
    np.random.seed(42)

    base_time = datetime.datetime(2026, 11, 15, 0, 0, 0, tzinfo=datetime.timezone.utc)
    current_sim_time = base_time

    # Designate roles across the entire 500 account space (NO isolated ID range)
    mule_pool = set(random.sample(ALL_ACCOUNTS, 60))
    compromised_pool = set(random.sample([a for a in ALL_ACCOUNTS if a not in mule_pool and a not in MERCHANT_ACCOUNTS], 35))
    power_users = random.sample([a for a in ALL_ACCOUNTS if a not in mule_pool and a not in MERCHANT_ACCOUNTS], 30)

    txns: List[Transaction] = []
    local_fraud_ids: Set[str] = set()

    # Pre-configure family devices for device collision hard negatives
    family_device_list = list(FAMILY_DEVICES.items())

    while len(txns) < target_count:
        # Batch of normal and hard-negative transactions (between 120 and 220)
        n_legit_batch = random.randint(120, 220)
        for _ in range(n_legit_batch):
            if len(txns) >= target_count:
                break

            roll = random.random()

            # 1. Hard Negative: High fan-in merchant transaction (~12%)
            if roll < 0.12:
                merchant = random.choice(MERCHANT_ACCOUNTS)
                sender = random.choice([a for a in ALL_ACCOUNTS if a != merchant])
                amt = round(random.lognormvariate(math.log(450), 0.7), 2)
                amt = max(15.0, min(amt, 3500.0))
                t = Transaction(
                    txn_id=f"TXN_MERCH_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=sender,
                    receiver_id=merchant,
                    amount=amt,
                    device_id=f"DEV_{sender}",
                    ip=_ip_from_account(sender),
                    channel="UPI",
                )

            # 2. Hard Negative: Family shared device transaction (~8%)
            elif roll < 0.20:
                dev_id, members = random.choice(family_device_list)
                sender = random.choice(members)
                receiver = random.choice([a for a in ALL_ACCOUNTS if a not in members])
                amt = round(random.lognormvariate(math.log(600), 0.6), 2)
                t = Transaction(
                    txn_id=f"TXN_FAM_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=sender,
                    receiver_id=receiver,
                    amount=amt,
                    device_id=dev_id,
                    ip="192.168.10.5",
                    channel="UPI",
                )

            # 3. Hard Negative: High amount spike (~3%)
            elif roll < 0.23:
                sender = random.choice(ALL_ACCOUNTS)
                receiver = random.choice([a for a in ALL_ACCOUNTS if a != sender])
                amt = round(random.uniform(9000.0, 18000.0), 2)
                t = Transaction(
                    txn_id=f"TXN_SPIKE_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=sender,
                    receiver_id=receiver,
                    amount=amt,
                    device_id=f"DEV_{sender}",
                    ip=_ip_from_account(sender),
                    channel="UPI",
                )

            # 4. Standard normal transaction (~77%)
            else:
                sender = random.choice(power_users if random.random() < 0.15 else ALL_ACCOUNTS)
                receiver = random.choice([a for a in ALL_ACCOUNTS if a != sender])
                amt = round(random.lognormvariate(math.log(650), 0.75), 2)
                amt = max(10.0, min(amt, 4200.0))
                t = Transaction(
                    txn_id=f"TXN_NORM_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=sender,
                    receiver_id=receiver,
                    amount=amt,
                    device_id=f"DEV_{sender}",
                    ip=_ip_from_account(sender),
                    channel="UPI",
                )

            txns.append(t)
            current_sim_time += datetime.timedelta(seconds=random.uniform(0.5, 4.0))

        # 5. Hard Negative: Salary day burst (~15-20 payroll transfers)
        if random.random() < 0.25 and len(txns) < target_count:
            employer = random.choice(EMPLOYER_ACCOUNTS)
            n_emp = random.randint(10, 16)
            recipients = random.sample([a for a in ALL_ACCOUNTS if a != employer], n_emp)
            pay_start = current_sim_time
            for i, emp in enumerate(recipients):
                amt = round(random.uniform(22000.0, 48000.0), 2)
                t_stamp = (pay_start + datetime.timedelta(seconds=i * random.uniform(1.0, 2.5))).isoformat()
                t = Transaction(
                    txn_id=f"TXN_PAY_{uuid.uuid4().hex[:12]}",
                    timestamp=t_stamp,
                    sender_id=employer,
                    receiver_id=emp,
                    amount=amt,
                    device_id=f"DEV_CORP_{employer}",
                    ip=_ip_from_account(employer),
                    channel="UPI",
                )
                txns.append(t)
            current_sim_time += datetime.timedelta(seconds=random.uniform(20, 60))

        if len(txns) >= target_count:
            break

        # 6. Fraud Scenario Injection
        attack_type = random.choice(["velocity", "ring", "fanout", "stealth"])
        scenario_txns: List[Transaction] = []

        if attack_type == "velocity":
            # 50% from dedicated mule, 50% from compromised honest account
            is_comp = random.random() < 0.50
            sender = random.choice(list(compromised_pool) if is_comp else list(mule_pool))
            n_vel = random.randint(10, 16)
            recipients = random.sample([a for a in ALL_ACCOUNTS if a != sender], n_vel)
            vel_start = current_sim_time
            for i, rec in enumerate(recipients):
                delta_s = i * random.uniform(0.8, 3.5)
                # Hard positive: 15% of velocity txns look completely normal
                if random.random() < 0.15:
                    amt = round(random.uniform(150.0, 850.0), 2)
                    dev_id = f"DEV_CLEAN_{uuid.uuid4().hex[:6]}"
                else:
                    amt = round(random.uniform(4300.0, 4999.0), 2)
                    dev_id = f"DEV_{sender}"
                t = Transaction(
                    txn_id=f"TXN_VEL_{uuid.uuid4().hex[:12]}",
                    timestamp=(vel_start + datetime.timedelta(seconds=delta_s)).isoformat() if delta_s > 0 else vel_start.isoformat(),
                    sender_id=sender,
                    receiver_id=rec,
                    amount=amt,
                    device_id=dev_id,
                    ip=_ip_from_account(sender),
                    channel="UPI",
                )
                scenario_txns.append(t)

        elif attack_type == "ring":
            # Varied ring size (3 to 7)
            r_size = random.choice([3, 4, 5, 6, 7])
            r_accounts = random.sample(ALL_ACCOUNTS, r_size)
            laps = random.randint(2, 3)
            # Hard positive: 50% of rings do NOT share a device!
            use_shared_dev = random.random() < 0.50
            shared_dev_id = f"DEV_RING_{uuid.uuid4().hex[:8]}" if use_shared_dev else None
            # Varied start amount and irregular decay
            curr_amt = round(random.uniform(25000.0, 55000.0), 2)
            decay_rate = random.uniform(0.94, 0.985)
            ring_start = current_sim_time

            hop_idx = 0
            for _ in range(laps):
                for i in range(r_size):
                    s_node = r_accounts[i]
                    r_node = r_accounts[(i + 1) % r_size]
                    curr_amt = round(curr_amt * decay_rate, 2)
                    # Hard positive: 50% timing gaps are long (>5 min, up to 25 min)
                    time_gap = random.uniform(3.0, 12.0) if random.random() < 0.60 else random.uniform(320.0, 900.0)
                    ring_start += datetime.timedelta(seconds=time_gap)
                    # Hard positive: 15% stealth amount
                    if random.random() < 0.15:
                        amt = round(random.uniform(200.0, 950.0), 2)
                    else:
                        amt = curr_amt
                    dev_id = shared_dev_id if use_shared_dev else f"DEV_{s_node}_{uuid.uuid4().hex[:4]}"
                    ip = "10.99.0.1" if use_shared_dev else _ip_from_account(s_node)
                    t = Transaction(
                        txn_id=f"TXN_RING_{uuid.uuid4().hex[:12]}",
                        timestamp=ring_start.isoformat(),
                        sender_id=s_node,
                        receiver_id=r_node,
                        amount=amt,
                        device_id=dev_id,
                        ip=ip,
                        channel="UPI",
                    )
                    scenario_txns.append(t)
                    hop_idx += 1

        elif attack_type == "fanout":
            n_mules = random.randint(5, 9)
            victims = random.sample([a for a in ALL_ACCOUNTS if a not in mule_pool], n_mules)
            mules = random.sample(list(mule_pool), n_mules)
            cashout = random.choice([a for a in ALL_ACCOUNTS if a not in mules])
            mule_amounts = []
            fan_start = current_sim_time
            # Victims -> mules
            for i in range(n_mules):
                amt = round(random.uniform(5000.0, 9500.0), 2)
                mule_amounts.append(amt)
                t_time = (fan_start + datetime.timedelta(seconds=i * random.uniform(2.0, 5.0))).isoformat()
                scenario_txns.append(
                    Transaction(
                        txn_id=f"TXN_VIC_{uuid.uuid4().hex[:12]}",
                        timestamp=t_time,
                        sender_id=victims[i],
                        receiver_id=mules[i],
                        amount=amt,
                        device_id=f"DEV_{victims[i]}",
                        ip=_ip_from_account(victims[i]),
                        channel="UPI",
                    )
                )
            # Mules -> cashout
            fan_start += datetime.timedelta(seconds=random.uniform(15, 60))
            for i in range(n_mules):
                fwd_amt = round(mule_amounts[i] * random.uniform(0.85, 0.95), 2)
                t_time = (fan_start + datetime.timedelta(seconds=i * random.uniform(2.0, 6.0))).isoformat()
                scenario_txns.append(
                    Transaction(
                        txn_id=f"TXN_MULE_{uuid.uuid4().hex[:12]}",
                        timestamp=t_time,
                        sender_id=mules[i],
                        receiver_id=cashout,
                        amount=fwd_amt,
                        device_id=f"DEV_{mules[i]}",
                        ip=_ip_from_account(mules[i]),
                        channel="UPI",
                    )
                )

        elif attack_type == "stealth":
            # Pure standalone stealth fraud (hard positives)
            n_stealth = random.randint(4, 8)
            for _ in range(n_stealth):
                s = random.choice(list(compromised_pool | mule_pool))
                r = random.choice([a for a in ALL_ACCOUNTS if a != s])
                amt = round(random.uniform(120.0, 850.0), 2)
                scenario_txns.append(
                    Transaction(
                        txn_id=f"TXN_STL_{uuid.uuid4().hex[:12]}",
                        timestamp=current_sim_time.isoformat(),
                        sender_id=s,
                        receiver_id=r,
                        amount=amt,
                        device_id=f"DEV_CLEAN_{uuid.uuid4().hex[:6]}",
                        ip=_ip_from_account(s),
                        channel="UPI",
                    )
                )
                current_sim_time += datetime.timedelta(seconds=random.uniform(5.0, 25.0))

        for t in scenario_txns:
            local_fraud_ids.add(t.txn_id)
            FRAUD_TXN_IDS.add(t.txn_id)
        txns.extend(scenario_txns)
        current_sim_time += datetime.timedelta(seconds=random.uniform(10, 45))

    # Sort strictly chronologically
    txns.sort(key=lambda x: x.timestamp)
    print(f"Generated {len(txns):,} total txns, {len(local_fraud_ids):,} ground-truth fraud ({len(local_fraud_ids)/len(txns):.2%}).")
    return txns, local_fraud_ids


def replay_and_extract(
    txns: List[Transaction],
    fraud_ids: Set[str],
) -> Tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Replay stream in chronological order with graph and state updates (no future leakage)."""
    print("Replaying transactions sequentially and extracting features...")
    state = EngineState()
    graph_engine = GraphEngine()

    features_list: List[Dict[str, float]] = []
    labels: List[int] = []
    rule_scores: List[int] = []

    start_t = time.perf_counter()
    n_txns = len(txns)

    graph_cache = graph_engine.get_cache()

    for idx, txn in enumerate(txns):
        # Background graph engine periodic recompute (every 2,500 txns)
        if idx > 0 and idx % 2500 == 0:
            graph_cache = graph_engine.recompute_cache()

        # 1. Extract features prior to updating state with current txn
        feat = extract_features(txn, state=state, graph_cache=graph_cache)
        features_list.append(feat)

        # 2. Evaluate rules (internally updates state via state.update(txn))
        reasons = evaluate(txn, state=state)
        r_score = score_from_reasons(reasons)
        rule_scores.append(r_score)

        # 3. Label: ground truth
        is_fraud = 1 if (txn.txn_id in fraud_ids or txn.txn_id in FRAUD_TXN_IDS) else 0
        labels.append(is_fraud)

        # 4. Ingest into graph engine
        graph_engine.add_transaction(txn, risk=r_score / 100.0)

        if (idx + 1) % 10000 == 0 or (idx + 1) == n_txns:
            elapsed = time.perf_counter() - start_t
            rate = (idx + 1) / elapsed
            print(f"Processed {idx + 1:,}/{n_txns:,} txns ({rate:,.0f} txns/sec)")

    df_features = pd.DataFrame(features_list)
    y = np.array(labels, dtype=int)
    rule_scores_arr = np.array(rule_scores, dtype=int)

    return df_features, y, rule_scores_arr


def evaluate_models(
    y_test: np.ndarray,
    rule_scores_test: np.ndarray,
    ml_probs_test: np.ndarray,
) -> Dict[str, Any]:
    """Evaluate Rules, ML, and Blended strategies."""
    # (a) Rules only: threshold >= 40 (REVIEW or BLOCK)
    y_pred_rules = (rule_scores_test >= 40).astype(int)
    rules_prec = precision_score(y_test, y_pred_rules, zero_division=0)
    rules_rec = recall_score(y_test, y_pred_rules, zero_division=0)
    rules_f1 = f1_score(y_test, y_pred_rules, zero_division=0)
    rules_roc_auc = roc_auc_score(y_test, rule_scores_test / 100.0)
    p_curve, r_curve, _ = precision_recall_curve(y_test, rule_scores_test / 100.0)
    rules_pr_auc = auc(r_curve, p_curve)
    rules_cm = confusion_matrix(y_test, y_pred_rules, labels=[0, 1]).tolist()

    # (b) ML only: probability >= 0.50
    y_pred_ml = (ml_probs_test >= 0.50).astype(int)
    ml_prec = precision_score(y_test, y_pred_ml, zero_division=0)
    ml_rec = recall_score(y_test, y_pred_ml, zero_division=0)
    ml_f1 = f1_score(y_test, y_pred_ml, zero_division=0)
    ml_roc_auc = roc_auc_score(y_test, ml_probs_test)
    p_curve, r_curve, _ = precision_recall_curve(y_test, ml_probs_test)
    ml_pr_auc = auc(r_curve, p_curve)
    ml_cm = confusion_matrix(y_test, y_pred_ml, labels=[0, 1]).tolist()

    # (c) Blended: final_score = round(0.4 * rule_score + 0.6 * ml_score) >= 40
    ml_scores_test = np.round(ml_probs_test * 100).astype(int)
    blended_scores = np.round(0.4 * rule_scores_test + 0.6 * ml_scores_test).astype(int)
    y_pred_blended = (blended_scores >= 40).astype(int)
    blended_prec = precision_score(y_test, y_pred_blended, zero_division=0)
    blended_rec = recall_score(y_test, y_pred_blended, zero_division=0)
    blended_f1 = f1_score(y_test, y_pred_blended, zero_division=0)
    blended_roc_auc = roc_auc_score(y_test, blended_scores / 100.0)
    p_curve, r_curve, _ = precision_recall_curve(y_test, blended_scores / 100.0)
    blended_pr_auc = auc(r_curve, p_curve)
    blended_cm = confusion_matrix(y_test, y_pred_blended, labels=[0, 1]).tolist()

    report = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "test_samples": int(len(y_test)),
        "test_fraud_count": int(np.sum(y_test)),
        "rules_only": {
            "precision": float(rules_prec),
            "recall": float(rules_rec),
            "f1_score": float(rules_f1),
            "roc_auc": float(rules_roc_auc),
            "pr_auc": float(rules_pr_auc),
            "confusion_matrix": rules_cm,
        },
        "ml_only": {
            "precision": float(ml_prec),
            "recall": float(ml_rec),
            "f1_score": float(ml_f1),
            "roc_auc": float(ml_roc_auc),
            "pr_auc": float(ml_pr_auc),
            "confusion_matrix": ml_cm,
        },
        "blended": {
            "precision": float(blended_prec),
            "recall": float(blended_rec),
            "f1_score": float(blended_f1),
            "roc_auc": float(blended_roc_auc),
            "pr_auc": float(blended_pr_auc),
            "confusion_matrix": blended_cm,
        },
    }

    return report


def plot_artifacts(
    model: xgb.XGBClassifier,
    feature_names: List[str],
    y_test: np.ndarray,
    rule_scores_test: np.ndarray,
    ml_probs_test: np.ndarray,
) -> None:
    """Generate and save feature importance chart and ROC curve."""
    importances = model.feature_importances_
    indices = np.argsort(importances)[::-1]
    sorted_features = [feature_names[i] for i in indices]
    sorted_importances = importances[indices]

    # Feature Importance Plot
    plt.figure(figsize=(10, 6))
    plt.barh(range(len(sorted_features)), sorted_importances[::-1], align="center", color="#2563eb")
    plt.yticks(range(len(sorted_features)), sorted_features[::-1])
    plt.xlabel("Relative Importance")
    plt.title("FraudShield ML - Feature Importance (XGBoost)")
    plt.grid(axis="x", linestyle="--", alpha=0.7)
    plt.tight_layout()
    feat_img_path = os.path.join(DOCS_DIR, "feature_importance.png")
    plt.savefig(feat_img_path, dpi=200)
    plt.close()
    print(f"Feature importance saved to: {feat_img_path}")

    # ROC Curve Plot
    fpr_rules, tpr_rules, _ = roc_curve(y_test, rule_scores_test / 100.0)
    fpr_ml, tpr_ml, _ = roc_curve(y_test, ml_probs_test)
    blended_scores = np.round(0.4 * rule_scores_test + 0.6 * np.round(ml_probs_test * 100)) / 100.0
    fpr_blend, tpr_blend, _ = roc_curve(y_test, blended_scores)

    auc_rules = roc_auc_score(y_test, rule_scores_test / 100.0)
    auc_ml = roc_auc_score(y_test, ml_probs_test)
    auc_blend = roc_auc_score(y_test, blended_scores)

    plt.figure(figsize=(8, 6))
    plt.plot(fpr_rules, tpr_rules, label=f"Rules Only (AUC = {auc_rules:.3f})", color="#f59e0b", linestyle="--")
    plt.plot(fpr_ml, tpr_ml, label=f"ML Only (AUC = {auc_ml:.3f})", color="#3b82f6", linewidth=2)
    plt.plot(fpr_blend, tpr_blend, label=f"Blended (Rules + ML) (AUC = {auc_blend:.3f})", color="#10b981", linewidth=2.5)
    plt.plot([0, 1], [0, 1], color="grey", linestyle=":")
    plt.xlabel("False Positive Rate")
    plt.ylabel("True Positive Rate")
    plt.title("FraudShield Detection - Receiver Operating Characteristic (ROC)")
    plt.legend(loc="lower right")
    plt.grid(True, linestyle="--", alpha=0.5)
    plt.tight_layout()
    roc_img_path = os.path.join(DOCS_DIR, "roc_curve.png")
    plt.savefig(roc_img_path, dpi=200)
    plt.close()
    print(f"ROC curve saved to: {roc_img_path}")


def measure_inference_latency(model_path: str, sample_row: Dict[str, float], n_calls: int = 10_000) -> float:
    """Measure inference latency over n_calls to ensure it meets < 2 ms budget."""
    artifact = joblib.load(model_path)
    model = artifact["model"]
    feature_names = artifact["feature_names"]

    row = np.array([[sample_row.get(name, 0.0) for name in feature_names]], dtype=np.float32)

    # Warmup
    for _ in range(50):
        _ = model.predict_proba(row)

    start = time.perf_counter()
    for _ in range(n_calls):
        _ = model.predict_proba(row)
    total_time = time.perf_counter() - start

    avg_ms = (total_time / n_calls) * 1000.0
    print(f"Latency over {n_calls:,} inference calls: total = {total_time:.4f}s, avg = {avg_ms:.4f} ms/call")
    return avg_ms


def main():
    print("=" * 65)
    print("FraudShield Machine Learning Training & Evaluation Pipeline")
    print("=" * 65)

    # 1. Dataset Generation (~50k realistic txns)
    txns, fraud_ids = generate_realistic_dataset(target_count=50_000)

    # 2. Sequential Replay and Feature Extraction
    df_features, y, rule_scores = replay_and_extract(txns, fraud_ids)

    # 3. Train/Test Split (80% Train, 20% Test chronologically)
    split_idx = int(len(df_features) * 0.8)
    X_train = df_features.iloc[:split_idx][FEATURE_NAMES].values.astype(np.float32)
    y_train = y[:split_idx]
    X_test = df_features.iloc[split_idx:][FEATURE_NAMES].values.astype(np.float32)
    y_test = y[split_idx:]
    rule_scores_test = rule_scores[split_idx:]

    print(f"\nTrain set: {len(X_train):,} samples ({np.sum(y_train):,} fraud, {np.mean(y_train):.2%})")
    print(f"Test set : {len(X_test):,} samples ({np.sum(y_test):,} fraud, {np.mean(y_test):.2%})")

    # 4. Train XGBoost with scale_pos_weight
    n_neg = np.sum(y_train == 0)
    n_pos = np.sum(y_train == 1)
    scale_weight = float(n_neg / n_pos) if n_pos > 0 else 1.0
    print(f"Calculated scale_pos_weight: {scale_weight:.2f}")

    clf = xgb.XGBClassifier(
        n_estimators=150,
        max_depth=5,
        learning_rate=0.08,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=scale_weight,
        eval_metric="logloss",
        random_state=42,
        tree_method="hist",
        n_jobs=-1,
    )

    print("Training XGBoost Classifier...")
    t0 = time.perf_counter()
    clf.fit(X_train, y_train)
    train_duration = time.perf_counter() - t0
    print(f"Training completed in {train_duration:.2f} seconds.")

    # 5. Predict on Test Set
    ml_probs_test = clf.predict_proba(X_test)[:, 1]

    # 6. Evaluate Rules, ML, and Blended
    report = evaluate_models(y_test, rule_scores_test, ml_probs_test)

    print("\n" + "=" * 65)
    print("Evaluation Results on Test Set (Out-of-Time 20%):")
    print("=" * 65)
    for model_name in ["rules_only", "ml_only", "blended"]:
        res = report[model_name]
        print(f"--- {model_name.upper()} ---")
        print(f"  Precision: {res['precision']:.4f} ({res['precision']*100:.2f}%)")
        print(f"  Recall   : {res['recall']:.4f} ({res['recall']*100:.2f}%)")
        print(f"  F1 Score : {res['f1_score']:.4f}")
        print(f"  ROC-AUC  : {res['roc_auc']:.4f}")
        print(f"  PR-AUC   : {res['pr_auc']:.4f}")
        print(f"  Confusion: {res['confusion_matrix']}")

    # 7. Print Top 10 Features
    importances = clf.feature_importances_
    indices = np.argsort(importances)[::-1]
    print("\n" + "=" * 65)
    print("Top 10 Most Important Features (XGBoost):")
    print("=" * 65)
    for rank, idx in enumerate(indices[:10], start=1):
        print(f"  {rank:2d}. {FEATURE_NAMES[idx]:<30} {importances[idx]:.4f} ({importances[idx]*100:.2f}%)")

    # 8. Save Report JSON
    report_path = os.path.join(DOCS_DIR, "ml_report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport written to: {report_path}")

    # 9. Save Model Artifact
    model_artifact_path = os.path.join(MODELS_DIR, "fraud_model.joblib")
    artifact = {
        "model": clf,
        "feature_names": FEATURE_NAMES,
        "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scale_pos_weight": scale_weight,
    }
    joblib.dump(artifact, model_artifact_path, compress=3)
    print(f"Model artifact saved to: {model_artifact_path}")

    # 10. Plotting Visualizations
    plot_artifacts(clf, FEATURE_NAMES, y_test, rule_scores_test, ml_probs_test)

    # 11. Measure Latency over 10,000 calls
    sample_feat = {name: float(X_test[0, i]) for i, name in enumerate(FEATURE_NAMES)}
    print("\nMeasuring inference latency...")
    avg_latency = measure_inference_latency(model_artifact_path, sample_feat, n_calls=10_000)
    print(f"Inference latency verification: {avg_latency:.4f} ms (budget < 2.0 ms: {'PASSED' if avg_latency < 2.0 else 'FAILED'})")
    print("=" * 65)


if __name__ == "__main__":
    main()
