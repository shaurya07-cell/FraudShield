"""Comprehensive training, calibration, and ablation pipeline for FraudShield Multi-Model Ensemble.

Generates ~60,000 realistic transactions with noise and hard edge-cases:
- Fraud accounts mixed across general ID space (no separate range)
- Hard negatives: merchants with high fan-in, salary bursts, family shared devices, large legit purchases
- Hard positives: ~15% stealth fraud (normal amounts/pace), unshared device rings, varied delays
- Sequential replay through EngineState and GraphEngine (zero data leakage)
- Split: 70% Train, 10% Validation (for Meta-Model), 20% Test (for Ablation)
- Saves specialist models, calibrated meta-model, and evaluation artifacts in docs/
"""
import argparse
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
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LogisticRegression
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
from app.ml import extract_features
from app.models_ensemble import (
    ANOMALY_FEATURES,
    DEVICE_FEATURES,
    FEATURE_NAMES,
    GRAPH_FEATURES,
    META_FEATURE_NAMES,
    BehaviourProfileModel,
)
from app.rules import evaluate, score_from_reasons
from app.schemas import Transaction
from app.simulator import (
    ALL_ACCOUNTS,
    EMPLOYER_ACCOUNTS,
    FAMILY_DEVICES,
    MERCHANT_ACCOUNTS,
    _ip_from_account,
)
from app.state import EngineState

DEFAULT_MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models_v2"))
DOCS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "docs"))


def generate_ensemble_dataset(target_count: int = 60_000) -> Tuple[List[Transaction], Set[str]]:
    """Synthesize ~60,000 realistic transactions with mixed mule accounts and hard edge-cases."""
    print(f"Synthesizing ~{target_count:,} realistic transactions with noise & edge-cases...")
    random.seed(42)
    np.random.seed(42)

    base_time = datetime.datetime(2026, 11, 15, 0, 0, 0, tzinfo=datetime.timezone.utc)
    current_sim_time = base_time

    # Designate mule accounts randomly mixed into the honest space (NO separate ID range)
    mule_pool = set(random.sample(ALL_ACCOUNTS, 75))
    compromised_pool = set(random.sample([a for a in ALL_ACCOUNTS if a not in mule_pool and a not in MERCHANT_ACCOUNTS], 40))
    power_users = random.sample([a for a in ALL_ACCOUNTS if a not in mule_pool and a not in MERCHANT_ACCOUNTS], 35)

    txns: List[Transaction] = []
    local_fraud_ids: Set[str] = set()
    family_device_list = list(FAMILY_DEVICES.items())

    while len(txns) < target_count:
        # Legitimate batch with realistic edge cases (130 - 240 txns)
        n_legit_batch = random.randint(130, 240)
        for _ in range(n_legit_batch):
            if len(txns) >= target_count:
                break

            roll = random.random()

            # 1. Hard Negative: Merchant high fan-in (~12%)
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
                txns.append(t)
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.3, 1.8))

            # 2. Hard Negative: Family shared device (~8%)
            elif roll < 0.20:
                fam_dev, fam_members = random.choice(family_device_list)
                sender = random.choice(fam_members)
                receiver = random.choice([a for a in ALL_ACCOUNTS if a not in fam_members])
                amt = round(random.uniform(50.0, 1500.0), 2)
                t = Transaction(
                    txn_id=f"TXN_FAM_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=sender,
                    receiver_id=receiver,
                    amount=amt,
                    device_id=fam_dev,
                    ip=_ip_from_account(sender),
                    channel="UPI",
                )
                txns.append(t)
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.5, 3.0))

            # 3. Hard Negative: Salary day burst (~5%)
            elif roll < 0.25:
                emp_sender = random.choice(EMPLOYER_ACCOUNTS)
                emp_dev = f"DEV_PAYROLL_{emp_sender}"
                employees = random.sample([a for a in ALL_ACCOUNTS if a != emp_sender and a not in MERCHANT_ACCOUNTS], random.randint(8, 16))
                for emp in employees:
                    sal = round(random.uniform(25000.0, 85000.0), 2)
                    t = Transaction(
                        txn_id=f"TXN_SAL_{uuid.uuid4().hex[:12]}",
                        timestamp=current_sim_time.isoformat(),
                        sender_id=emp_sender,
                        receiver_id=emp,
                        amount=sal,
                        device_id=emp_dev,
                        ip=_ip_from_account(emp_sender),
                        channel="UPI",
                    )
                    txns.append(t)
                    current_sim_time += datetime.timedelta(seconds=random.uniform(0.05, 0.4))

            # 4. Hard Negative: Legitimate large purchase / bill (~4%)
            elif roll < 0.29:
                sender = random.choice([a for a in ALL_ACCOUNTS if a not in mule_pool])
                receiver = random.choice(MERCHANT_ACCOUNTS)
                amt = round(random.uniform(15000.0, 48000.0), 2)
                t = Transaction(
                    txn_id=f"TXN_EXP_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=sender,
                    receiver_id=receiver,
                    amount=amt,
                    device_id=f"DEV_{sender}",
                    ip=_ip_from_account(sender),
                    channel="UPI",
                )
                txns.append(t)
                current_sim_time += datetime.timedelta(seconds=random.uniform(1.0, 4.0))

            # 5. Standard normal payment (~71%)
            else:
                sender = random.choice(power_users) if random.random() < 0.25 else random.choice(ALL_ACCOUNTS)
                receiver = random.choice([a for a in ALL_ACCOUNTS if a != sender])
                amt = round(random.lognormvariate(math.log(650), 0.85), 2)
                amt = max(10.0, min(amt, 9500.0))
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
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.4, 2.5))

        if len(txns) >= target_count:
            break

        # Fraud Attack Scenarios
        fraud_roll = random.random()

        # Attack Scenario A: Velocity Burst
        if fraud_roll < 0.35:
            is_compromised = random.random() < 0.40
            fraud_sender = random.choice(list(compromised_pool)) if is_compromised else random.choice(list(mule_pool))
            is_stealth = random.random() < 0.15
            n_burst = random.randint(12, 18)
            receivers = random.sample([a for a in ALL_ACCOUNTS if a != fraud_sender], n_burst)

            for rec in receivers:
                amt = round(random.uniform(250.0, 850.0), 2) if is_stealth else round(random.uniform(4750.0, 4999.0), 2)
                t = Transaction(
                    txn_id=f"TXN_VEL_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=fraud_sender,
                    receiver_id=rec,
                    amount=amt,
                    device_id=f"DEV_BOT_{fraud_sender}",
                    ip=_ip_from_account(fraud_sender),
                    channel="UPI",
                )
                txns.append(t)
                local_fraud_ids.add(t.txn_id)
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.5, 3.5))

        # Attack Scenario B: Fraud Ring
        elif fraud_roll < 0.70:
            ring_size = random.choice([3, 4, 5, 7])
            members = random.sample(list(mule_pool), ring_size)
            laps = random.randint(2, 4)
            base_amt = round(random.uniform(12000.0, 38000.0), 2)
            share_device = random.random() < 0.55
            ring_device = f"DEV_RING_{uuid.uuid4().hex[:6]}" if share_device else None
            is_stealth = random.random() < 0.15

            curr_amt = base_amt
            for _ in range(laps):
                for i in range(ring_size):
                    s = members[i]
                    r = members[(i + 1) % ring_size]
                    dev = ring_device if share_device else f"DEV_{s}"
                    actual_amt = round(random.uniform(300.0, 900.0), 2) if is_stealth else round(curr_amt, 2)
                    t = Transaction(
                        txn_id=f"TXN_RING_{uuid.uuid4().hex[:12]}",
                        timestamp=current_sim_time.isoformat(),
                        sender_id=s,
                        receiver_id=r,
                        amount=actual_amt,
                        device_id=dev,
                        ip=_ip_from_account(s),
                        channel="UPI",
                    )
                    txns.append(t)
                    local_fraud_ids.add(t.txn_id)
                    curr_amt *= random.uniform(0.96, 0.99)
                    current_sim_time += datetime.timedelta(seconds=random.uniform(2.0, 8.0))

        # Attack Scenario C: Fan-out Cash-out
        else:
            aggregator = random.choice(list(mule_pool))
            mules = random.sample([a for a in mule_pool if a != aggregator], random.randint(5, 8))
            is_stealth = random.random() < 0.15

            # Step 1: Inflow to mules
            for m in mules:
                victim = random.choice(ALL_ACCOUNTS)
                in_amt = round(random.uniform(350.0, 950.0), 2) if is_stealth else round(random.uniform(6000.0, 9500.0), 2)
                t_in = Transaction(
                    txn_id=f"TXN_FAN_IN_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=victim,
                    receiver_id=m,
                    amount=in_amt,
                    device_id=f"DEV_{victim}",
                    ip=_ip_from_account(victim),
                    channel="UPI",
                )
                txns.append(t_in)
                current_sim_time += datetime.timedelta(seconds=random.uniform(1.0, 4.0))

            # Step 2: Forward to aggregator
            for m in mules:
                fwd_amt = round(random.uniform(300.0, 850.0), 2) if is_stealth else round(random.uniform(5500.0, 9000.0), 2)
                t_fwd = Transaction(
                    txn_id=f"TXN_FAN_OUT_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=m,
                    receiver_id=aggregator,
                    amount=fwd_amt,
                    device_id=f"DEV_{m}",
                    ip=_ip_from_account(m),
                    channel="UPI",
                )
                txns.append(t_fwd)
                local_fraud_ids.add(t_fwd.txn_id)
                current_sim_time += datetime.timedelta(seconds=random.uniform(1.0, 5.0))

    # Chronological sort
    txns.sort(key=lambda x: x.timestamp)
    print(f"Dataset generated: {len(txns):,} transactions ({len(local_fraud_ids):,} fraud, {len(local_fraud_ids)/len(txns):.2%}).")
    return txns, local_fraud_ids


def main():
    parser = argparse.ArgumentParser(description="Train FraudShield models without label leakage.")
    parser.add_argument(
        "--out-dir",
        type=str,
        default=DEFAULT_MODELS_DIR,
        help="Directory to save trained model artifacts (default: backend/models_v2, never backend/models)",
    )
    parser.add_argument(
        "--report-file",
        type=str,
        default="ml_report_v2.json",
        help="Filename for the evaluation report in docs/ (default: ml_report_v2.json)",
    )
    args = parser.parse_args()

    models_dir = os.path.abspath(args.out_dir)
    forbidden_models_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
    if os.path.commonpath([models_dir, forbidden_models_dir]) == forbidden_models_dir and models_dir == forbidden_models_dir:
        raise ValueError(f"Refusing to write to protected production models directory: {models_dir}")

    os.makedirs(models_dir, exist_ok=True)
    os.makedirs(DOCS_DIR, exist_ok=True)

    print("=" * 70)
    print("FraudShield Multi-Model Specialist Ensemble Training & Calibration")
    print(f"Artifacts output directory: {models_dir}")
    print(f"Report file: docs/{args.report_file}")
    print("=" * 70)

    # 1. Dataset Generation
    txns, fraud_ids = generate_ensemble_dataset(target_count=60_000)

    # 2. Sequential Replay for Zero-Leakage Feature Extraction
    print("Replaying transactions sequentially through EngineState & GraphEngine...")
    state = EngineState()
    graph_engine = GraphEngine()
    profile_model = BehaviourProfileModel()

    feature_records: List[Dict[str, float]] = []
    rule_scores: List[int] = []
    labels: List[int] = []
    profile_scores: List[float] = []

    last_cache_recompute_idx = 0
    t0_extract = time.perf_counter()

    for idx, txn in enumerate(txns):
        # Periodic graph cache recomputation (every 800 transactions, out-of-band)
        if idx - last_cache_recompute_idx >= 800:
            graph_engine.recompute_cache()
            last_cache_recompute_idx = idx

        # Rule evaluation & Rule score
        reasons = evaluate(txn, state=state)
        r_score = score_from_reasons(reasons)
        rule_scores.append(r_score)

        # Feature extraction strictly before updating state
        feats = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())
        feature_records.append(feats)

        # Profile model deviation score
        prof_score = profile_model.predict_score(txn.sender_id, float(txn.amount), txn.receiver_id)
        profile_scores.append(prof_score)

        # Labeling
        is_fraud = 1 if txn.txn_id in fraud_ids else 0
        labels.append(is_fraud)

        # Update in-memory structures (Zero Label Leakage)
        # Live and Training Parity Rule: Node risk is updated strictly using the heuristic
        # rule score available at evaluation time (r_score / 100.0). Ground truth is_fraud is NEVER
        # fed into the graph, matching live scoring and eliminating label contamination.
        state.update(txn)
        graph_engine.add_transaction(txn, risk=r_score / 100.0)
        profile_model.update_account(txn.sender_id, float(txn.amount), txn.receiver_id)

    extract_duration = time.perf_counter() - t0_extract
    print(f"Replay completed in {extract_duration:.1f}s ({len(txns)/extract_duration:.0f} txn/s).")

    # Final cache computation
    graph_engine.recompute_cache()

    # 3. Splits: 70% Train, 10% Validation, 20% Test (chronologically ordered)
    total_samples = len(txns)
    train_end = int(total_samples * 0.70)
    val_end = int(total_samples * 0.80)

    train_fraud = sum(labels[:train_end])
    val_fraud = sum(labels[train_end:val_end])
    test_fraud = sum(labels[val_end:])

    print("\nDataset Split Summary (strictly chronological):")
    print(f"  Train: {train_end:,} txns, fraud={train_fraud:,} ({train_fraud/train_end:.2%}), [{txns[0].timestamp} to {txns[train_end-1].timestamp}]")
    print(f"  Val:   {val_end - train_end:,} txns, fraud={val_fraud:,} ({val_fraud/(val_end - train_end):.2%}), [{txns[train_end].timestamp} to {txns[val_end-1].timestamp}]")
    print(f"  Test:  {total_samples - val_end:,} txns, fraud={test_fraud:,} ({test_fraud/(total_samples - val_end):.2%}), [{txns[val_end].timestamp} to {txns[-1].timestamp}]")

    X_all = pd.DataFrame(feature_records)
    y_all = np.array(labels, dtype=int)
    rules_all = np.array(rule_scores, dtype=float) / 100.0
    prof_all = np.array(profile_scores, dtype=float)

    X_train = X_all.iloc[:train_end]
    y_train = y_all[:train_end]
    rules_train = rules_all[:train_end]
    prof_train = prof_all[:train_end]

    X_val = X_all.iloc[train_end:val_end]
    y_val = y_all[train_end:val_end]
    rules_val = rules_all[train_end:val_end]
    prof_val = prof_all[train_end:val_end]

    X_test = X_all.iloc[val_end:]
    y_test = y_all[val_end:]
    rules_test = rules_all[val_end:]
    prof_test = prof_all[val_end:]

    print(f"\nData Splits:")
    print(f"  Train: {len(X_train):,} ({sum(y_train):,} fraud, {sum(y_train)/len(y_train):.2%})")
    print(f"  Val:   {len(X_val):,} ({sum(y_val):,} fraud, {sum(y_val)/len(y_val):.2%})")
    print(f"  Test:  {len(X_test):,} ({sum(y_test):,} fraud, {sum(y_test)/len(y_test):.2%})")

    neg_count = sum(y_train == 0)
    pos_count = sum(y_train == 1)
    spw = float(neg_count) / float(max(pos_count, 1))

    # -------------------------------------------------------------
    # Model A: Supervised XGBoost
    # -------------------------------------------------------------
    print("\nTraining Model A: Supervised XGBoost...")
    supervised_model = xgb.XGBClassifier(
        n_estimators=120,
        max_depth=5,
        learning_rate=0.08,
        scale_pos_weight=spw,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        eval_metric="logloss",
    )
    supervised_model.fit(X_train[FEATURE_NAMES], y_train)

    # -------------------------------------------------------------
    # Model B: Anomaly Detector (Isolation Forest)
    # -------------------------------------------------------------
    print("Training Model B: Anomaly Detector (Isolation Forest on legit traffic)...")
    legit_mask = y_train == 0
    anomaly_model = IsolationForest(
        n_estimators=45,
        contamination=0.06,
        random_state=42,
        n_jobs=-1,
    )
    anomaly_model.fit(X_train.loc[legit_mask, ANOMALY_FEATURES])

    def score_anomaly(model, df_feats):
        raw = model.decision_function(df_feats[ANOMALY_FEATURES])
        return 1.0 / (1.0 + np.exp(raw * 10.0))

    # -------------------------------------------------------------
    # Model C: Behaviour Profile Model
    # -------------------------------------------------------------
    print("Model C: Behaviour Profile Model (pre-trained running state)...")
    # Saved profile_model is ready for use

    # -------------------------------------------------------------
    # Model D: Graph Specialist Model
    # -------------------------------------------------------------
    print("Training Model D: Graph Specialist Model...")
    graph_model = xgb.XGBClassifier(
        n_estimators=90,
        max_depth=4,
        learning_rate=0.08,
        scale_pos_weight=spw,
        subsample=0.85,
        random_state=42,
        eval_metric="logloss",
    )
    graph_model.fit(X_train[GRAPH_FEATURES], y_train)

    # -------------------------------------------------------------
    # Model E: Device and Identity Specialist Model
    # -------------------------------------------------------------
    print("Training Model E: Device & Identity Model...")
    device_model = xgb.XGBClassifier(
        n_estimators=75,
        max_depth=3,
        learning_rate=0.08,
        scale_pos_weight=spw,
        subsample=0.85,
        random_state=42,
        eval_metric="logloss",
    )
    device_model.fit(X_train[DEVICE_FEATURES], y_train)

    # -------------------------------------------------------------
    # Model F: Meta-Model trained on Validation Split
    # -------------------------------------------------------------
    print("Training Model F: Meta-Model on Validation Split...")
    val_pred_sup = supervised_model.predict_proba(X_val[FEATURE_NAMES])[:, 1]
    val_pred_anom = score_anomaly(anomaly_model, X_val)
    val_pred_prof = prof_val
    val_pred_graph = graph_model.predict_proba(X_val[GRAPH_FEATURES])[:, 1]
    val_pred_dev = device_model.predict_proba(X_val[DEVICE_FEATURES])[:, 1]

    X_val_meta = np.column_stack([
        val_pred_sup,
        val_pred_anom,
        val_pred_prof,
        val_pred_graph,
        val_pred_dev,
        rules_val,
    ])

    base_meta = LogisticRegression(class_weight="balanced", C=1.0, max_iter=200, random_state=42)
    meta_model = CalibratedClassifierCV(estimator=base_meta, method="sigmoid", cv=3)
    meta_model.fit(X_val_meta, y_val)

    # -------------------------------------------------------------
    # Save Model Artifacts
    # -------------------------------------------------------------
    print(f"\nSaving model artifacts to {models_dir}...")
    joblib.dump(supervised_model, os.path.join(models_dir, "supervised_xgb.joblib"))
    joblib.dump(supervised_model, os.path.join(models_dir, "fraud_model.joblib"))
    joblib.dump(anomaly_model, os.path.join(models_dir, "anomaly_iforest.joblib"))
    joblib.dump(profile_model, os.path.join(models_dir, "behaviour_profile.joblib"))
    joblib.dump(graph_model, os.path.join(models_dir, "graph_model.joblib"))
    joblib.dump(device_model, os.path.join(models_dir, "device_identity_model.joblib"))
    joblib.dump(meta_model, os.path.join(models_dir, "meta_model.joblib"))
    print("All models serialized successfully.")

    # -------------------------------------------------------------
    # Evaluation on Test Split (Ablation Table)
    # -------------------------------------------------------------
    print("\n" + "=" * 70)
    print("EVALUATION ON TEST SPLIT (12,000 TRANSACTIONS)")
    print("=" * 70)

    test_pred_sup = supervised_model.predict_proba(X_test[FEATURE_NAMES])[:, 1]
    test_pred_anom = score_anomaly(anomaly_model, X_test)
    test_pred_prof = prof_test
    test_pred_graph = graph_model.predict_proba(X_test[GRAPH_FEATURES])[:, 1]
    test_pred_dev = device_model.predict_proba(X_test[DEVICE_FEATURES])[:, 1]

    X_test_meta = np.column_stack([
        test_pred_sup,
        test_pred_anom,
        test_pred_prof,
        test_pred_graph,
        test_pred_dev,
        rules_test,
    ])
    test_pred_ensemble = meta_model.predict_proba(X_test_meta)[:, 1]

    models_to_eval = {
        "rules_only": (rules_test, rules_test >= 0.40),
        "supervised_xgb": (test_pred_sup, test_pred_sup >= 0.50),
        "anomaly_iforest": (test_pred_anom, test_pred_anom >= 0.50),
        "behaviour_profile": (test_pred_prof, test_pred_prof >= 0.40),
        "graph_model": (test_pred_graph, test_pred_graph >= 0.50),
        "device_model": (test_pred_dev, test_pred_dev >= 0.50),
        "full_ensemble": (test_pred_ensemble, test_pred_ensemble >= 0.40),
    }

    metrics_report: Dict[str, Any] = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "total_test_samples": len(y_test),
        "test_fraud_count": int(sum(y_test)),
        "ablation_results": {},
    }

    print(f"{'Model':<20} | {'Prec':<7} | {'Recall':<7} | {'F1':<7} | {'ROC-AUC':<8} | {'PR-AUC':<8} | {'FPR':<7}")
    print("-" * 75)

    for name, (scores, binary_pred) in models_to_eval.items():
        prec = float(precision_score(y_test, binary_pred, zero_division=0))
        rec = float(recall_score(y_test, binary_pred, zero_division=0))
        f1 = float(f1_score(y_test, binary_pred, zero_division=0))
        roc = float(roc_auc_score(y_test, scores))

        p_curve, r_curve, _ = precision_recall_curve(y_test, scores)
        pr_auc = float(auc(r_curve, p_curve))

        cm = confusion_matrix(y_test, binary_pred)
        tn, fp, fn, tp = cm.ravel()
        fpr = float(fp) / float(fp + tn) if (fp + tn) > 0 else 0.0

        metrics_report["ablation_results"][name] = {
            "precision": prec,
            "recall": rec,
            "f1_score": f1,
            "roc_auc": roc,
            "pr_auc": pr_auc,
            "false_positive_rate": fpr,
            "confusion_matrix": cm.tolist(),
        }

        print(f"{name:<20} | {prec:.4f}  | {rec:.4f}  | {f1:.4f}  | {roc:.4f}   | {pr_auc:.4f}   | {fpr:.4f}")

    # Latency Profiling (10,000 calls)
    print("\nMeasuring inference latency over 10,000 transactions...")
    sample_feat_dict = X_test.iloc[0].to_dict()
    sample_txn = txns[val_end]

    t0_sup = time.perf_counter()
    for _ in range(10_000):
        _ = supervised_model.predict_proba(np.array([[sample_feat_dict[f] for f in FEATURE_NAMES]]))
    sup_lat_ms = (time.perf_counter() - t0_sup) / 10.0

    t0_anom = time.perf_counter()
    sample_anom_vec = np.array([[sample_feat_dict[f] for f in ANOMALY_FEATURES]])
    for _ in range(10_000):
        _ = anomaly_model.decision_function(sample_anom_vec)
    anom_lat_ms = (time.perf_counter() - t0_anom) / 10.0

    t0_prof = time.perf_counter()
    for _ in range(10_000):
        _ = profile_model.predict_score(sample_txn.sender_id, float(sample_txn.amount), sample_txn.receiver_id)
    prof_lat_ms = (time.perf_counter() - t0_prof) / 10.0

    t0_graph = time.perf_counter()
    sample_graph_vec = np.array([[sample_feat_dict[f] for f in GRAPH_FEATURES]])
    for _ in range(10_000):
        _ = graph_model.predict_proba(sample_graph_vec)
    graph_lat_ms = (time.perf_counter() - t0_graph) / 10.0

    t0_dev = time.perf_counter()
    sample_dev_vec = np.array([[sample_feat_dict[f] for f in DEVICE_FEATURES]])
    for _ in range(10_000):
        _ = device_model.predict_proba(sample_dev_vec)
    dev_lat_ms = (time.perf_counter() - t0_dev) / 10.0

    sample_meta_vec = np.array([[0.8, 0.7, 0.6, 0.9, 0.8, 0.5]])
    t0_meta = time.perf_counter()
    for _ in range(10_000):
        _ = meta_model.predict_proba(sample_meta_vec)
    meta_lat_ms = (time.perf_counter() - t0_meta) / 10.0

    total_ensemble_lat_ms = sup_lat_ms + anom_lat_ms + prof_lat_ms + graph_lat_ms + dev_lat_ms + meta_lat_ms

    latency_report = {
        "supervised_xgb_ms": round(sup_lat_ms, 3),
        "anomaly_iforest_ms": round(anom_lat_ms, 3),
        "behaviour_profile_ms": round(prof_lat_ms, 3),
        "graph_model_ms": round(graph_lat_ms, 3),
        "device_model_ms": round(dev_lat_ms, 3),
        "meta_model_ms": round(meta_lat_ms, 3),
        "total_ensemble_inference_ms": round(total_ensemble_lat_ms, 3),
    }
    metrics_report["latency_profile"] = latency_report

    print(f"\nInference Latencies (avg per call):")
    for k, v in latency_report.items():
        print(f"  {k}: {v:.3f} ms")

    # Save docs/ml_report_v2.json (or specified report-file)
    report_path = os.path.join(DOCS_DIR, args.report_file)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(metrics_report, f, indent=2)
    print(f"\nSaved report to docs/{args.report_file}")

    # -------------------------------------------------------------
    # Visualizations
    # -------------------------------------------------------------
    # 1. Ablation Bar Chart (docs/ablation.png)
    plt.figure(figsize=(10, 5), dpi=150)
    models_display = ["Rules", "Supervised", "Anomaly", "Profile", "Graph", "Device", "Ensemble"]
    f1_vals = [metrics_report["ablation_results"][k]["f1_score"] for k in models_to_eval.keys()]
    auc_vals = [metrics_report["ablation_results"][k]["roc_auc"] for k in models_to_eval.keys()]
    pr_vals = [metrics_report["ablation_results"][k]["pr_auc"] for k in models_to_eval.keys()]

    x = np.arange(len(models_display))
    width = 0.25

    plt.bar(x - width, f1_vals, width, label="F1 Score", color="#1F4FD8")
    plt.bar(x, auc_vals, width, label="ROC-AUC", color="#1E8E5A")
    plt.bar(x + width, pr_vals, width, label="PR-AUC", color="#B7791F")

    plt.ylabel("Score")
    plt.title("Model Ablation Comparison on Test Split (N=12,000)")
    plt.xticks(x, models_display)
    plt.ylim(0.0, 1.05)
    plt.grid(axis="y", linestyle="--", alpha=0.5)
    plt.legend(loc="lower right")
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "ablation.png"))
    plt.close()

    # 2. Feature Importance (docs/feature_importance.png)
    importances = supervised_model.feature_importances_
    sorted_idx = np.argsort(importances)
    plt.figure(figsize=(9, 6), dpi=150)
    plt.barh(range(len(sorted_idx)), importances[sorted_idx], color="#1F4FD8", align="center")
    plt.yticks(range(len(sorted_idx)), [FEATURE_NAMES[i] for i in sorted_idx], fontsize=9)
    plt.xlabel("XGBoost Gini Importance")
    plt.title("Ensemble Supervised Model Feature Importance")
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "feature_importance.png"))
    plt.close()

    # 3. ROC Curves (docs/roc_curve.png)
    plt.figure(figsize=(8, 6), dpi=150)
    colors = {
        "rules_only": ("#5B6575", "--", "Rules Only"),
        "supervised_xgb": ("#4F46E5", "-", "Supervised XGB"),
        "graph_model": ("#06B6D4", "-", "Graph Specialist"),
        "full_ensemble": ("#1E8E5A", "-", "Full Calibrated Ensemble"),
    }
    for m_key, (col, style, lbl) in colors.items():
        scores, _ = models_to_eval[m_key]
        fpr_arr, tpr_arr, _ = roc_curve(y_test, scores)
        r_auc = auc(fpr_arr, tpr_arr)
        plt.plot(fpr_arr, tpr_arr, color=col, linestyle=style, lw=2, label=f"{lbl} (AUC = {r_auc:.3f})")

    plt.plot([0, 1], [0, 1], "k--", lw=1)
    plt.xlim([0.0, 1.0])
    plt.ylim([0.0, 1.05])
    plt.xlabel("False Positive Rate")
    plt.ylabel("True Positive Rate")
    plt.title("Comparative ROC Curves on Test Split")
    plt.legend(loc="lower right")
    plt.grid(True, linestyle="--", alpha=0.5)
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "roc_curve.png"))
    plt.close()

    # 4. Confusion Matrix (docs/confusion_matrix.png)
    ens_cm = np.array(metrics_report["ablation_results"]["full_ensemble"]["confusion_matrix"])
    plt.figure(figsize=(5, 4), dpi=150)
    plt.imshow(ens_cm, interpolation="nearest", cmap=plt.cm.Blues)
    plt.title("Ensemble Confusion Matrix (Test Split)")
    plt.colorbar()
    tick_marks = np.arange(2)
    plt.xticks(tick_marks, ["Legitimate", "Fraud"])
    plt.yticks(tick_marks, ["Legitimate", "Fraud"])

    thresh = ens_cm.max() / 2.0
    for i in range(ens_cm.shape[0]):
        for j in range(ens_cm.shape[1]):
            plt.text(
                j,
                i,
                f"{ens_cm[i, j]:,}",
                horizontalalignment="center",
                color="white" if ens_cm[i, j] > thresh else "black",
                fontweight="bold",
            )
    plt.ylabel("Actual Label")
    plt.xlabel("Predicted Label")
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "confusion_matrix.png"))
    plt.close()

    print("All plots saved in docs/ (ablation.png, feature_importance.png, roc_curve.png, confusion_matrix.png).")
    print("=" * 70)


if __name__ == "__main__":
    main()
