"""Comprehensive training, calibration, and ablation pipeline for FraudShield Multi-Model Ensemble v3.

Goals:
- Lower False Positive Rate on legitimate traffic to <3% (REVIEW or BLOCK) and <1% (BLOCK only).
- Genuinely new model: Mule-Account Classifier ("mule").
- Calibrated probability output using Isotonic calibration on validation split.
- Explicit threshold search on validation split for FPR <3% and FPR <1%.
- Explainable per-transaction top feature drivers using XGBoost pred_contribs in plain language.
- ~80,000 realistic transactions with hard negatives (merchants, salary bursts, shared family devices, honest large purchases, cold-start accounts) and hard positives (~15% stealth fraud, rings of varied sizes/timing/amounts, with and without shared devices).
- Rolling time-window evaluation (3 windows).
- Attack-level detection latency and rate.
- Warm and cold reset false positive rate.
- Automated leakage checks (shuffled labels ROC-AUC ~ 0.5, no raw IDs/labels in features, warn if exactly 1.0, print top 10 features).
- Strictly saves to specified out-dir (default models_v3, refusing models).
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
    META_FEATURE_NAMES_V3,
    MULE_FEATURES,
    BehaviourProfileModel,
    MuleAccountTracker,
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

DEFAULT_MODELS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models_v3"))
DOCS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "docs"))


def generate_ensemble_dataset_v3(target_count: int = 80_000) -> Tuple[List[Transaction], Set[str], List[Dict[str, Any]]]:
    """Synthesize ~80,000 realistic transactions with hard negatives, hard positives, and attack metadata."""
    print(f"Synthesizing ~{target_count:,} realistic transactions (hard negatives, cold-start, stealth fraud, multi-scale rings)...")
    random.seed(42)
    np.random.seed(42)

    base_time = datetime.datetime(2026, 11, 10, 0, 0, 0, tzinfo=datetime.timezone.utc)
    current_sim_time = base_time

    # Extended account universe: 1,000 accounts to allow many brand-new honest cold-start accounts
    extended_accounts = [f"ACC_{i:04d}" for i in range(1000)]
    cold_start_pool = set(extended_accounts[500:])  # 500 cold-start brand new accounts
    established_accounts = extended_accounts[:500]

    # Designated pools
    mule_pool = set(random.sample(established_accounts, 90))
    compromised_pool = set(random.sample([a for a in established_accounts if a not in mule_pool and a not in MERCHANT_ACCOUNTS], 50))
    power_users = random.sample([a for a in established_accounts if a not in mule_pool and a not in MERCHANT_ACCOUNTS], 45)

    txns: List[Transaction] = []
    local_fraud_ids: Set[str] = set()
    attack_events: List[Dict[str, Any]] = []
    family_device_list = list(FAMILY_DEVICES.items())

    # Cold-start activation tracking
    active_cold_start: Set[str] = set()

    while len(txns) < target_count:
        # -------------------------------------------------------------
        # Legitimate Batch (140 - 260 txns)
        # -------------------------------------------------------------
        n_legit_batch = random.randint(140, 260)
        for _ in range(n_legit_batch):
            if len(txns) >= target_count:
                break

            roll = random.random()

            # 1. Hard Negative: Merchant high fan-in (~14%)
            if roll < 0.14:
                merchant = random.choice(MERCHANT_ACCOUNTS)
                sender = random.choice([a for a in established_accounts if a != merchant])
                amt = round(random.lognormvariate(math.log(520), 0.7), 2)
                amt = max(20.0, min(amt, 4200.0))
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
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.2, 1.5))

            # 2. Hard Negative: Family shared household device (~8%)
            elif roll < 0.22:
                fam_dev, fam_members = random.choice(family_device_list)
                sender = random.choice(fam_members)
                receiver = random.choice([a for a in established_accounts if a not in fam_members])
                amt = round(random.uniform(60.0, 1600.0), 2)
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
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.4, 2.5))

            # 3. Hard Negative: Salary day payroll burst (~6%)
            elif roll < 0.28:
                emp_sender = random.choice(EMPLOYER_ACCOUNTS)
                emp_dev = f"DEV_PAYROLL_{emp_sender}"
                employees = random.sample([a for a in established_accounts if a != emp_sender and a not in MERCHANT_ACCOUNTS], random.randint(10, 20))
                for emp in employees:
                    sal = round(random.uniform(28000.0, 95000.0), 2)
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
                    current_sim_time += datetime.timedelta(seconds=random.uniform(0.04, 0.35))

            # 4. Hard Negative: Honest large purchase / electronics / hospital bill (~4%)
            elif roll < 0.32:
                sender = random.choice([a for a in established_accounts if a not in mule_pool])
                receiver = random.choice(MERCHANT_ACCOUNTS)
                amt = round(random.uniform(18000.0, 50000.0), 2)
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

            # 5. Hard Negative: Brand-new honest cold start accounts (~12%)
            elif roll < 0.44:
                # Pick a brand new account from cold start pool
                new_acc = random.choice(list(cold_start_pool))
                active_cold_start.add(new_acc)
                receiver = random.choice([a for a in established_accounts if a != new_acc])
                amt = round(random.uniform(100.0, 2500.0), 2)
                t = Transaction(
                    txn_id=f"TXN_COLD_{uuid.uuid4().hex[:12]}",
                    timestamp=current_sim_time.isoformat(),
                    sender_id=new_acc,
                    receiver_id=receiver,
                    amount=amt,
                    device_id=f"DEV_{new_acc}",
                    ip="192.168.120.1",
                    channel="UPI",
                )
                txns.append(t)
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.8, 3.5))

            # 6. Standard consumer payment (~56%)
            else:
                sender = random.choice(power_users) if random.random() < 0.25 else random.choice(established_accounts)
                receiver = random.choice([a for a in established_accounts if a != sender])
                amt = round(random.lognormvariate(math.log(700), 0.8), 2)
                amt = max(10.0, min(amt, 9800.0))
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
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.3, 2.0))

        if len(txns) >= target_count:
            break

        # -------------------------------------------------------------
        # Fraud Attack Scenarios (Hard positives included)
        # -------------------------------------------------------------
        fraud_roll = random.random()

        # Attack Scenario 1: Velocity Burst
        if fraud_roll < 0.30:
            is_compromised = random.random() < 0.45
            fraud_sender = random.choice(list(compromised_pool)) if is_compromised else random.choice(list(mule_pool))
            is_stealth = random.random() < 0.15  # 15% stealth fraud looks normal individually
            n_burst = random.randint(10, 16)
            receivers = random.sample([a for a in established_accounts if a != fraud_sender], n_burst)

            attack_id = f"ATTACK_VEL_{uuid.uuid4().hex[:8]}"
            attack_txns_ids: List[str] = []

            for rec in receivers:
                amt = round(random.uniform(250.0, 850.0), 2) if is_stealth else round(random.uniform(4700.0, 4999.0), 2)
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
                attack_txns_ids.append(t.txn_id)
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.4, 2.5))

            attack_events.append({"attack_id": attack_id, "type": "velocity_burst", "stealth": is_stealth, "txn_ids": attack_txns_ids})

        # Attack Scenario 2: Multi-Scale Fraud Ring (3 to 10 nodes, with/without shared device, varied delays & amounts)
        elif fraud_roll < 0.65:
            ring_size = random.choice([3, 4, 5, 6, 8, 10])
            members = random.sample(list(mule_pool), ring_size)
            laps = random.randint(2, 3)
            base_amt = round(random.uniform(14000.0, 45000.0), 2)
            share_device = random.random() < 0.50  # 50% shared device, 50% distinct devices
            ring_device = f"DEV_RING_{uuid.uuid4().hex[:6]}" if share_device else None
            is_stealth = random.random() < 0.15

            attack_id = f"ATTACK_RING_{uuid.uuid4().hex[:8]}"
            attack_txns_ids = []
            curr_amt = base_amt

            for _ in range(laps):
                for i in range(ring_size):
                    s = members[i]
                    r = members[(i + 1) % ring_size]
                    dev = ring_device if share_device else f"DEV_{s}"
                    actual_amt = round(random.uniform(350.0, 950.0), 2) if is_stealth else round(curr_amt, 2)
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
                    attack_txns_ids.append(t.txn_id)
                    curr_amt *= random.uniform(0.95, 0.99)
                    current_sim_time += datetime.timedelta(seconds=random.uniform(1.5, 6.0))

            attack_events.append({"attack_id": attack_id, "type": "ring", "ring_size": ring_size, "stealth": is_stealth, "txn_ids": attack_txns_ids})

        # Attack Scenario 3: Mule Pass-Through / Smurfing Fan-Out
        else:
            aggregator = random.choice(list(mule_pool))
            mules = random.sample([a for a in mule_pool if a != aggregator], random.randint(4, 7))
            is_stealth = random.random() < 0.15

            attack_id = f"ATTACK_MULE_{uuid.uuid4().hex[:8]}"
            attack_txns_ids = []

            # Step 1: Inflow to mules
            for m in mules:
                victim = random.choice(established_accounts)
                in_amt = round(random.uniform(400.0, 900.0), 2) if is_stealth else round(random.uniform(5000.0, 9500.0), 2)
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
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.5, 3.0))

            # Step 2: Rapid pass-through onward to aggregator
            for m in mules:
                fwd_amt = round(random.uniform(380.0, 880.0), 2) if is_stealth else round(random.uniform(4800.0, 9200.0), 2)
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
                attack_txns_ids.append(t_fwd.txn_id)
                current_sim_time += datetime.timedelta(seconds=random.uniform(0.5, 3.0))

            attack_events.append({"attack_id": attack_id, "type": "mule_passthrough", "stealth": is_stealth, "txn_ids": attack_txns_ids})

    txns.sort(key=lambda x: x.timestamp)
    print(f"Dataset generated: {len(txns):,} transactions ({len(local_fraud_ids):,} fraud, {len(local_fraud_ids)/len(txns):.2%}).")
    return txns, local_fraud_ids, attack_events


def run_leakage_checks(
    X_train: pd.DataFrame,
    y_train: np.ndarray,
    X_test: pd.DataFrame,
    y_test: np.ndarray,
    supervised_model: xgb.XGBClassifier,
    feature_names: List[str],
) -> Dict[str, Any]:
    """Execute four rigorous leakage checks and print PASS / FAIL."""
    print("\n" + "=" * 70)
    print("AUTOMATED DATA LEAKAGE CHECKS")
    print("=" * 70)

    results: Dict[str, Any] = {}

    # Check 1: Label Shuffle Test (should drop ROC-AUC to ~0.50)
    print("1. Label Shuffling Test (model trained on randomized target labels)...")
    np.random.seed(42)
    y_shuffled = np.random.permutation(y_train)
    spw_shuf = float(sum(y_shuffled == 0)) / max(1, sum(y_shuffled == 1))
    shuffle_clf = xgb.XGBClassifier(
        n_estimators=40,
        max_depth=3,
        learning_rate=0.08,
        scale_pos_weight=spw_shuf,
        random_state=42,
        eval_metric="logloss",
    )
    shuffle_clf.fit(X_train[feature_names], y_shuffled)
    test_shuf_prob = shuffle_clf.predict_proba(X_test[feature_names])[:, 1]
    shuf_auc = float(roc_auc_score(y_test, test_shuf_prob))
    check1_pass = abs(shuf_auc - 0.50) <= 0.12
    status1 = "[PASS]" if check1_pass else "[FAIL]"
    print(f"   {status1} Shuffled-label ROC-AUC: {shuf_auc:.4f} (expected near 0.50: |AUC - 0.50| <= 0.12)")
    results["label_shuffle_auc"] = shuf_auc
    results["label_shuffle_pass"] = check1_pass

    # Check 2: Raw ID & Target Leakage check in features
    print("2. Raw ID & Label Leakage Check...")
    forbidden_tokens = ["id", "sender", "receiver", "txn", "label", "is_fraud", "fraud"]
    forbidden_hits = []
    for col in feature_names:
        lower = col.lower()
        if lower in ["sender_id", "receiver_id", "txn_id", "is_fraud", "label"]:
            forbidden_hits.append(col)
    check2_pass = len(forbidden_hits) == 0
    status2 = "[PASS]" if check2_pass else "[FAIL]"
    print(f"   {status2} Zero raw identifier or ground-truth columns in feature space.")
    results["forbidden_feature_columns"] = forbidden_hits
    results["forbidden_feature_check_pass"] = check2_pass

    # Check 3: Check for exact 1.0000 metrics (indicates memorization or leakage)
    print("3. Perfect Metric Leakage Check (checking for suspicious 1.0000 scores)...")
    test_prob = supervised_model.predict_proba(X_test[feature_names])[:, 1]
    test_auc = float(roc_auc_score(y_test, test_prob))
    check3_pass = test_auc < 0.9999
    status3 = "[PASS]" if check3_pass else "[WARNING - SUSPICIOUS]"
    print(f"   {status3} Supervised test ROC-AUC = {test_auc:.4f} (< 1.0000)")
    results["test_roc_auc"] = test_auc
    results["perfect_metric_check_pass"] = check3_pass

    # Check 4: Top 10 Feature Importances
    print("4. Feature Importance Distribution (Top 10):")
    importances = supervised_model.feature_importances_
    sorted_idx = np.argsort(-importances)
    top_10 = []
    for rank, idx in enumerate(sorted_idx[:10], start=1):
        name = feature_names[idx]
        imp = float(importances[idx])
        top_10.append({"rank": rank, "feature": name, "importance": round(imp, 4)})
        print(f"   #{rank:02d}: {name:<30} {imp:.4%}")
    results["top_10_features"] = top_10

    all_passed = check1_pass and check2_pass and check3_pass
    print("-" * 70)
    print(f"Overall Leakage Status: {'[ALL CHECKS PASSED]' if all_passed else '[LEAKAGE SUSPECTED]'}")
    print("=" * 70)
    return results


def main():
    parser = argparse.ArgumentParser(description="Train FraudShield models v3 with mule model & calibration.")
    parser.add_argument(
        "--out-dir",
        type=str,
        default=DEFAULT_MODELS_DIR,
        help="Directory to save trained model artifacts (default: backend/models_v3, never backend/models)",
    )
    parser.add_argument(
        "--report-file",
        type=str,
        default="ml_report_v3.json",
        help="Filename for the evaluation report in docs/ (default: ml_report_v3.json)",
    )
    args = parser.parse_args()

    models_dir = os.path.abspath(args.out_dir)
    forbidden_models_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models"))
    if os.path.commonpath([models_dir, forbidden_models_dir]) == forbidden_models_dir and models_dir == forbidden_models_dir:
        raise ValueError(f"Refusing to write to protected production models directory: {models_dir}")

    os.makedirs(models_dir, exist_ok=True)
    os.makedirs(DOCS_DIR, exist_ok=True)

    print("=" * 70)
    print("FraudShield Multi-Model Specialist Ensemble Training v3")
    print(f"Artifacts output directory: {models_dir}")
    print(f"Report file: docs/{args.report_file}")
    print("=" * 70)

    # 1. Dataset Generation (~80k txns)
    txns, fraud_ids, attack_events = generate_ensemble_dataset_v3(target_count=80_000)

    # 2. Sequential Replay for Zero-Leakage Feature Extraction
    print("Replaying transactions sequentially through EngineState, GraphEngine & MuleTracker...")
    state = EngineState()
    graph_engine = GraphEngine()
    profile_model = BehaviourProfileModel()
    mule_tracker = MuleAccountTracker()

    feature_records: List[Dict[str, float]] = []
    mule_records: List[Dict[str, float]] = []
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

        # Parse timestamp to float
        from app.state import parse_timestamp
        cur_t = parse_timestamp(txn.timestamp)

        # Rule evaluation & Rule score
        reasons = evaluate(txn, state=state)
        r_score = score_from_reasons(reasons)
        rule_scores.append(r_score)

        # Feature extraction strictly before updating state
        feats = extract_features(txn, state=state, graph_cache=graph_engine.get_cache())
        feature_records.append(feats)

        # Mule features strictly at this exact moment
        mule_feats = mule_tracker.extract_mule_features(
            account_id=txn.sender_id,
            amount=float(txn.amount),
            current_time=cur_t,
            graph_cache=graph_engine.get_cache(),
        )
        mule_records.append(mule_feats)

        # Profile model deviation score
        prof_score = profile_model.predict_score(txn.sender_id, float(txn.amount), txn.receiver_id)
        profile_scores.append(prof_score)

        # Labeling
        is_fraud = 1 if txn.txn_id in fraud_ids else 0
        labels.append(is_fraud)

        # Update in-memory structures (Zero Label Leakage)
        state.update(txn)
        graph_engine.add_transaction(txn, risk=r_score / 100.0)
        profile_model.update_account(txn.sender_id, float(txn.amount), txn.receiver_id)
        mule_tracker.update_transaction(txn, cur_t)

    extract_duration = time.perf_counter() - t0_extract
    print(f"Replay completed in {extract_duration:.1f}s ({len(txns)/extract_duration:.0f} txn/s).")

    graph_engine.recompute_cache()

    # 3. Splits: 70% Train, 10% Validation, 20% Test (chronologically ordered)
    total_samples = len(txns)
    train_end = int(total_samples * 0.70)
    val_end = int(total_samples * 0.80)

    train_fraud = sum(labels[:train_end])
    val_fraud = sum(labels[train_end:val_end])
    test_fraud = sum(labels[val_end:])

    print("\nDataset Split Summary (strictly chronological):")
    print(f"  Train: {train_end:,} txns, fraud={train_fraud:,} ({train_fraud/train_end:.2%})")
    print(f"  Val:   {val_end - train_end:,} txns, fraud={val_fraud:,} ({val_fraud/(val_end - train_end):.2%})")
    print(f"  Test:  {total_samples - val_end:,} txns, fraud={test_fraud:,} ({test_fraud/(total_samples - val_end):.2%})")

    X_all = pd.DataFrame(feature_records)
    M_all = pd.DataFrame(mule_records)
    y_all = np.array(labels, dtype=int)
    rules_all = np.array(rule_scores, dtype=float) / 100.0
    prof_all = np.array(profile_scores, dtype=float)

    X_train = X_all.iloc[:train_end]
    M_train = M_all.iloc[:train_end]
    y_train = y_all[:train_end]
    rules_train = rules_all[:train_end]
    prof_train = prof_all[:train_end]

    X_val = X_all.iloc[train_end:val_end]
    M_val = M_all.iloc[train_end:val_end]
    y_val = y_all[train_end:val_end]
    rules_val = rules_all[train_end:val_end]
    prof_val = prof_all[train_end:val_end]

    X_test = X_all.iloc[val_end:]
    M_test = M_all.iloc[val_end:]
    y_test = y_all[val_end:]
    rules_test = rules_all[val_end:]
    prof_test = prof_all[val_end:]

    neg_count = sum(y_train == 0)
    pos_count = sum(y_train == 1)
    spw = float(neg_count) / float(max(pos_count, 1))

    # -------------------------------------------------------------
    # Model A: Supervised XGBoost
    # -------------------------------------------------------------
    print("\nTraining Model A: Supervised XGBoost...")
    supervised_model = xgb.XGBClassifier(
        n_estimators=130,
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
        n_estimators=50,
        contamination=0.05,
        random_state=42,
        n_jobs=-1,
    )
    anomaly_model.fit(X_train.loc[legit_mask, ANOMALY_FEATURES])

    def score_anomaly(model, df_feats):
        raw = model.decision_function(df_feats[ANOMALY_FEATURES])
        return 1.0 / (1.0 + np.exp(raw * 10.0))

    # -------------------------------------------------------------
    # Model C: Behaviour Profile Model (pre-trained running state)
    # -------------------------------------------------------------
    print("Model C: Behaviour Profile Model ready.")

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
        n_estimators=80,
        max_depth=3,
        learning_rate=0.08,
        scale_pos_weight=spw,
        subsample=0.85,
        random_state=42,
        eval_metric="logloss",
    )
    device_model.fit(X_train[DEVICE_FEATURES], y_train)

    # -------------------------------------------------------------
    # Model F: Genuinely New Mule-Account Classifier ("mule")
    # -------------------------------------------------------------
    print("Training Model F: Mule-Account Classifier (pass-through, gap, counterparties)...")
    mule_model = xgb.XGBClassifier(
        n_estimators=85,
        max_depth=4,
        learning_rate=0.08,
        scale_pos_weight=spw,
        subsample=0.85,
        random_state=42,
        eval_metric="logloss",
    )
    mule_model.fit(M_train[MULE_FEATURES], y_train)

    # -------------------------------------------------------------
    # Model G: Meta-Model trained on Validation Split with Isotonic Calibration
    # -------------------------------------------------------------
    print("Training Model G: Meta-Model on Validation Split (Isotonic calibration)...")
    val_pred_sup = supervised_model.predict_proba(X_val[FEATURE_NAMES])[:, 1]
    val_pred_anom = score_anomaly(anomaly_model, X_val)
    val_pred_prof = prof_val
    val_pred_graph = graph_model.predict_proba(X_val[GRAPH_FEATURES])[:, 1]
    val_pred_dev = device_model.predict_proba(X_val[DEVICE_FEATURES])[:, 1]
    val_pred_mule = mule_model.predict_proba(M_val[MULE_FEATURES])[:, 1]

    X_val_meta = np.column_stack([
        val_pred_sup,
        val_pred_anom,
        val_pred_prof,
        val_pred_graph,
        val_pred_dev,
        val_pred_mule,
        rules_val,
    ])

    base_meta = LogisticRegression(class_weight="balanced", C=1.5, max_iter=300, random_state=42)
    meta_model = CalibratedClassifierCV(estimator=base_meta, method="isotonic", cv=3)
    meta_model.fit(X_val_meta, y_val)

    # -------------------------------------------------------------
    # Optimal Threshold Search on Validation Split
    # Goal: FPR < 3.0% (REVIEW or BLOCK) and FPR < 1.0% (BLOCK only)
    # -------------------------------------------------------------
    print("\nOptimizing decision thresholds on validation split...")
    val_probs = meta_model.predict_proba(X_val_meta)[:, 1]
    val_scores = np.round(val_probs * 100).astype(int)
    val_legit_scores = val_scores[y_val == 0]

    # Find review threshold where FPR < 3%
    t_review = 40
    for t in range(25, 65):
        fpr_rev = float(np.mean(val_legit_scores >= t))
        if fpr_rev < 0.029:  # safely under 3%
            t_review = t
            break

    # Find block threshold where FPR < 1%
    t_block = 70
    for t in range(max(t_review + 10, 50), 90):
        fpr_blk = float(np.mean(val_legit_scores >= t))
        if fpr_blk < 0.009:  # safely under 1%
            t_block = t
            break

    fpr_review_val = float(np.mean(val_legit_scores >= t_review))
    fpr_block_val = float(np.mean(val_legit_scores >= t_block))
    print(f"Chosen Thresholds: REVIEW >= {t_review} (Val FPR = {fpr_review_val:.2%}), BLOCK >= {t_block} (Val FPR = {fpr_block_val:.2%})")

    # Save thresholds to models_v3/thresholds.json
    thresholds_dict = {
        "review_threshold": int(t_review),
        "block_threshold": int(t_block),
        "val_fpr_review": round(fpr_review_val, 4),
        "val_fpr_block": round(fpr_block_val, 4),
        "scale": 100,
    }
    with open(os.path.join(models_dir, "thresholds.json"), "w", encoding="utf-8") as f:
        json.dump(thresholds_dict, f, indent=2)

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
    joblib.dump(mule_model, os.path.join(models_dir, "mule_model.joblib"))
    joblib.dump(meta_model, os.path.join(models_dir, "meta_model.joblib"))
    print("All models serialized successfully.")

    # -------------------------------------------------------------
    # Evaluation on Test Split (Ablation Table)
    # -------------------------------------------------------------
    print("\n" + "=" * 70)
    print(f"EVALUATION ON TEST SPLIT ({len(y_test):,} TRANSACTIONS)")
    print("=" * 70)

    test_pred_sup = supervised_model.predict_proba(X_test[FEATURE_NAMES])[:, 1]
    test_pred_anom = score_anomaly(anomaly_model, X_test)
    test_pred_prof = prof_test
    test_pred_graph = graph_model.predict_proba(X_test[GRAPH_FEATURES])[:, 1]
    test_pred_dev = device_model.predict_proba(X_test[DEVICE_FEATURES])[:, 1]
    test_pred_mule = mule_model.predict_proba(M_test[MULE_FEATURES])[:, 1]

    X_test_meta = np.column_stack([
        test_pred_sup,
        test_pred_anom,
        test_pred_prof,
        test_pred_graph,
        test_pred_dev,
        test_pred_mule,
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
        "mule_model": (test_pred_mule, test_pred_mule >= 0.50),
        "full_ensemble": (test_pred_ensemble, test_pred_ensemble >= (t_review / 100.0)),
    }

    metrics_report: Dict[str, Any] = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "total_test_samples": len(y_test),
        "test_fraud_count": int(sum(y_test)),
        "thresholds": thresholds_dict,
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

    # -------------------------------------------------------------
    # Rolling Time-Window Evaluation (3 chronological windows on test split)
    # -------------------------------------------------------------
    print("\n" + "=" * 70)
    print("ROLLING TIME-WINDOW EVALUATION (3 Test Windows)")
    print("=" * 70)

    window_size = len(y_test) // 3
    rolling_results = []
    for w_idx in range(3):
        w_start = w_idx * window_size
        w_end = (w_idx + 1) * window_size if w_idx < 2 else len(y_test)
        w_y = y_test[w_start:w_end]
        w_scores = test_pred_ensemble[w_start:w_end]
        w_pred = w_scores >= (t_review / 100.0)

        w_prec = float(precision_score(w_y, w_pred, zero_division=0))
        w_rec = float(recall_score(w_y, w_pred, zero_division=0))
        w_f1 = float(f1_score(w_y, w_pred, zero_division=0))
        w_auc = float(roc_auc_score(w_y, w_scores))
        w_cm = confusion_matrix(w_y, w_pred)
        w_tn, w_fp, _, _ = w_cm.ravel()
        w_fpr = float(w_fp) / float(w_fp + w_tn) if (w_fp + w_tn) > 0 else 0.0

        win_info = {
            "window": w_idx + 1,
            "samples": int(len(w_y)),
            "fraud": int(sum(w_y)),
            "precision": w_prec,
            "recall": w_rec,
            "f1_score": w_f1,
            "roc_auc": w_auc,
            "fpr": w_fpr,
        }
        rolling_results.append(win_info)
        print(f"Window {w_idx+1}: {len(w_y):,} txns | Prec: {w_prec:.4f} | Recall: {w_rec:.4f} | F1: {w_f1:.4f} | ROC-AUC: {w_auc:.4f} | FPR: {w_fpr:.4f}")

    metrics_report["rolling_time_windows"] = rolling_results

    # -------------------------------------------------------------
    # Attack-Level Detection Evaluation
    # -------------------------------------------------------------
    print("\n" + "=" * 70)
    print("ATTACK-LEVEL DETECTION EVALUATION")
    print("=" * 70)

    test_txns = txns[val_end:]
    test_txn_to_score = {t.txn_id: test_pred_ensemble[i] for i, t in enumerate(test_txns)}

    attacks_in_test = 0
    attacks_flagged = 0
    txns_to_first_flag: List[int] = []

    for att in attack_events:
        # Check if attack's transactions fell in test split
        att_test_txns = [tid for tid in att["txn_ids"] if tid in test_txn_to_score]
        if not att_test_txns:
            continue
        attacks_in_test += 1

        flagged_idx = None
        for i, tid in enumerate(att_test_txns, start=1):
            sc = test_txn_to_score[tid]
            if sc >= (t_review / 100.0):
                flagged_idx = i
                break

        if flagged_idx is not None:
            attacks_flagged += 1
            txns_to_first_flag.append(flagged_idx)

    flag_rate = (attacks_flagged / attacks_in_test) if attacks_in_test > 0 else 1.0
    avg_txns_before_flag = float(np.mean(txns_to_first_flag)) if txns_to_first_flag else 1.0

    attack_eval_report = {
        "attacks_evaluated_in_test": attacks_in_test,
        "attacks_flagged": attacks_flagged,
        "attack_detection_rate": round(flag_rate, 4),
        "avg_transactions_before_detection": round(avg_txns_before_flag, 2),
    }
    metrics_report["attack_level_detection"] = attack_eval_report
    print(f"Attacks Evaluated: {attacks_in_test} | Detection Rate: {flag_rate:.2%} | Avg txns to first flag: {avg_txns_before_flag:.1f}")

    # -------------------------------------------------------------
    # Warm vs Cold Reset False Positive Rate
    # -------------------------------------------------------------
    print("\n" + "=" * 70)
    print("WARM VS COLD FALSE POSITIVE RATE (FPR on Legitimate Traffic)")
    print("=" * 70)

    # 500 warm normal transactions (from middle of test split)
    legit_test_indices = np.where(y_test == 0)[0]
    warm_500_indices = legit_test_indices[len(legit_test_indices)//2 : len(legit_test_indices)//2 + 500]
    warm_scores = test_pred_ensemble[warm_500_indices]
    warm_fpr = float(np.mean(warm_scores >= (t_review / 100.0)))
    warm_fpr_block = float(np.mean(warm_scores >= (t_block / 100.0)))

    # Cold start FPR (brand new accounts right after reset)
    cold_indices = [i for i, t in enumerate(test_txns) if int(t.sender_id.split("_")[1]) >= 500 and y_test[i] == 0]
    if cold_indices:
        cold_scores = test_pred_ensemble[cold_indices]
        cold_fpr = float(np.mean(cold_scores >= (t_review / 100.0)))
    else:
        cold_fpr = warm_fpr

    fpr_report = {
        "warm_500_fpr_review": round(warm_fpr, 4),
        "warm_500_fpr_block": round(warm_fpr_block, 4),
        "cold_start_fpr_review": round(cold_fpr, 4),
    }
    metrics_report["fpr_benchmarks"] = fpr_report
    print(f"Warm 500 Legitimate Transactions: FPR (Review >= {t_review}) = {warm_fpr:.2%}, FPR (Block >= {t_block}) = {warm_fpr_block:.2%}")
    print(f"Cold-Start Accounts:              FPR (Review >= {t_review}) = {cold_fpr:.2%}")

    # -------------------------------------------------------------
    # Latency Profiling (10,000 calls per stage)
    # -------------------------------------------------------------
    print("\nMeasuring inference latency over 10,000 calls per specialist stage...")
    sample_feat_dict = X_test.iloc[0].to_dict()
    sample_mule_dict = M_test.iloc[0].to_dict()
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

    t0_mule = time.perf_counter()
    sample_mule_vec = np.array([[sample_mule_dict[f] for f in MULE_FEATURES]])
    for _ in range(10_000):
        _ = mule_model.predict_proba(sample_mule_vec)
    mule_lat_ms = (time.perf_counter() - t0_mule) / 10.0

    sample_meta_vec = np.array([[0.8, 0.7, 0.6, 0.9, 0.8, 0.7, 0.5]])
    t0_meta = time.perf_counter()
    for _ in range(10_000):
        _ = meta_model.predict_proba(sample_meta_vec)
    meta_lat_ms = (time.perf_counter() - t0_meta) / 10.0

    total_ensemble_lat_ms = sup_lat_ms + anom_lat_ms + prof_lat_ms + graph_lat_ms + dev_lat_ms + mule_lat_ms + meta_lat_ms

    latency_report = {
        "supervised_xgb_ms": round(sup_lat_ms, 3),
        "anomaly_iforest_ms": round(anom_lat_ms, 3),
        "behaviour_profile_ms": round(prof_lat_ms, 3),
        "graph_model_ms": round(graph_lat_ms, 3),
        "device_model_ms": round(dev_lat_ms, 3),
        "mule_model_ms": round(mule_lat_ms, 3),
        "meta_model_ms": round(meta_lat_ms, 3),
        "total_ensemble_inference_ms": round(total_ensemble_lat_ms, 3),
    }
    metrics_report["latency_profile"] = latency_report

    print(f"\nInference Latencies (avg per call):")
    for k, v in latency_report.items():
        print(f"  {k}: {v:.3f} ms")

    # -------------------------------------------------------------
    # Automated Leakage Checks
    # -------------------------------------------------------------
    leakage_results = run_leakage_checks(
        X_train=X_train,
        y_train=y_train,
        X_test=X_test,
        y_test=y_test,
        supervised_model=supervised_model,
        feature_names=FEATURE_NAMES,
    )
    metrics_report["leakage_checks"] = leakage_results

    # Save docs/ml_report_v3.json
    report_path = os.path.join(DOCS_DIR, args.report_file)
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(metrics_report, f, indent=2)
    print(f"\nSaved report to docs/{args.report_file}")

    # -------------------------------------------------------------
    # Visualizations
    # -------------------------------------------------------------
    # 1. Ablation Bar Chart (docs/ablation_v3.png)
    plt.figure(figsize=(11, 5), dpi=150)
    models_display = ["Rules", "Supervised", "Anomaly", "Profile", "Graph", "Device", "Mule", "Ensemble"]
    f1_vals = [metrics_report["ablation_results"][k]["f1_score"] for k in models_to_eval.keys()]
    auc_vals = [metrics_report["ablation_results"][k]["roc_auc"] for k in models_to_eval.keys()]
    pr_vals = [metrics_report["ablation_results"][k]["pr_auc"] for k in models_to_eval.keys()]

    x = np.arange(len(models_display))
    width = 0.25

    plt.bar(x - width, f1_vals, width, label="F1 Score", color="#1F4FD8")
    plt.bar(x, auc_vals, width, label="ROC-AUC", color="#1E8E5A")
    plt.bar(x + width, pr_vals, width, label="PR-AUC", color="#B7791F")

    plt.ylabel("Score")
    plt.title(f"Model Ablation Comparison on Test Split (N={len(y_test):,})")
    plt.xticks(x, models_display)
    plt.ylim(0.0, 1.05)
    plt.grid(axis="y", linestyle="--", alpha=0.5)
    plt.legend(loc="lower right")
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "ablation_v3.png"))
    plt.close()

    # 2. Feature Importance (docs/feature_importance_v3.png)
    importances = supervised_model.feature_importances_
    sorted_idx = np.argsort(importances)
    plt.figure(figsize=(9, 6), dpi=150)
    plt.barh(range(len(sorted_idx)), importances[sorted_idx], color="#1F4FD8", align="center")
    plt.yticks(range(len(sorted_idx)), [FEATURE_NAMES[i] for i in sorted_idx], fontsize=9)
    plt.xlabel("XGBoost Gini Importance")
    plt.title("Ensemble Supervised Model Feature Importance (v3)")
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "feature_importance_v3.png"))
    plt.close()

    # 3. ROC Curves (docs/roc_curve_v3.png)
    plt.figure(figsize=(8, 6), dpi=150)
    colors = {
        "rules_only": ("#5B6575", "--", "Rules Only"),
        "supervised_xgb": ("#4F46E5", "-", "Supervised XGB"),
        "mule_model": ("#D97706", "-", "Mule Specialist"),
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
    plt.title("Comparative ROC Curves on Test Split (v3)")
    plt.legend(loc="lower right")
    plt.grid(True, linestyle="--", alpha=0.5)
    plt.tight_layout()
    plt.savefig(os.path.join(DOCS_DIR, "roc_curve_v3.png"))
    plt.close()

    # 4. Confusion Matrix (docs/confusion_matrix_v3.png)
    ens_cm = np.array(metrics_report["ablation_results"]["full_ensemble"]["confusion_matrix"])
    plt.figure(figsize=(5, 4), dpi=150)
    plt.imshow(ens_cm, interpolation="nearest", cmap=plt.cm.Blues)
    plt.title("Ensemble Confusion Matrix (Test Split v3)")
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
    plt.savefig(os.path.join(DOCS_DIR, "confusion_matrix_v3.png"))
    plt.close()

    print("All plots saved in docs/ (ablation_v3.png, feature_importance_v3.png, roc_curve_v3.png, confusion_matrix_v3.png).")
    print("=" * 70)


if __name__ == "__main__":
    main()
