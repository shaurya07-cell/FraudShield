"""FraudShield Audit Benchmark Script.

Measures the REAL production pipeline (rules + graph + ensemble models):
1. Latency: 2,000 transactions after a 200-transaction warm-up (mean, p50, p95, p99, max, stage breakdown).
2. HTTP end-to-end: 300 POST /score calls against FastAPI (same percentiles).
3. Scale: Graph scaling up to 5,000 accounts with background traffic, then 8-member cash-out ring detection.
4. Detection: scenario detection rates (velocity_attack, ring_attack, fanout_cashout).
5. False positives on 200 normal transactions: (a) cold start after reset, (b) after 500-transaction warm-up.
6. Environment metadata & JSON export to docs/audit_benchmark.json.
"""
from datetime import datetime, timezone
import json
import os
import platform
import sys
import time
from typing import Any, Dict, List, Tuple
import uuid

# Ensure backend root is on sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import networkx as nx
import numpy as np
import pydantic
import sklearn
import uvicorn
import xgboost as xgb
from fastapi.testclient import TestClient

from app.main import app
from app.graph_engine import GLOBAL_GRAPH, GraphEngine
from app.ml import extract_features
from app.models_ensemble import GLOBAL_ENSEMBLE
from app.rules import evaluate, score_from_reasons
from app.schemas import Transaction
from app.scorer import score_transaction
from app.simulator import fanout_cashout, normal_txn, ring_attack, velocity_attack
from app.state import GLOBAL_STATE, parse_timestamp


def compute_percentiles(times_ms: List[float]) -> Dict[str, float]:
    """Compute mean, p50, p95, p99, and max from a list of latencies in ms."""
    if not times_ms:
        return {"mean": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}
    arr = np.array(times_ms, dtype=np.float64)
    return {
        "mean": round(float(np.mean(arr)), 3),
        "p50": round(float(np.percentile(arr, 50)), 3),
        "p95": round(float(np.percentile(arr, 95)), 3),
        "p99": round(float(np.percentile(arr, 99)), 3),
        "max": round(float(np.max(arr)), 3),
    }


def reset_global_system_state():
    """Reset graph and engine states to clean baseline."""
    GLOBAL_STATE.reset()
    GLOBAL_GRAPH.reset()
    if hasattr(GLOBAL_ENSEMBLE, "profile_model"):
        GLOBAL_ENSEMBLE.profile_model.profiles.clear()
    if hasattr(GLOBAL_ENSEMBLE, "mule_tracker"):
        GLOBAL_ENSEMBLE.mule_tracker.accounts.clear()


# ============================================================================
# Section 1: Pipeline Micro-Benchmark & Latency Breakdown
# ============================================================================

def benchmark_pipeline_latency(warmup_n: int = 200, test_n: int = 2000) -> Dict[str, Any]:
    print(f"\n[1/5] Benchmarking Pipeline Latency ({test_n} txns, {warmup_n} warmup)...")
    reset_global_system_state()

    # Warm-up phase
    for _ in range(warmup_n):
        t = normal_txn()
        _ = score_transaction(t)

    total_latencies: List[float] = []
    rules_latencies: List[float] = []
    graph_latencies: List[float] = []
    extract_latencies: List[float] = []
    sup_latencies: List[float] = []
    anom_latencies: List[float] = []
    prof_latencies: List[float] = []
    graph_mod_latencies: List[float] = []
    dev_latencies: List[float] = []
    mule_latencies: List[float] = []
    meta_latencies: List[float] = []

    for i in range(test_n):
        txn = normal_txn()

        # Detailed breakdown timing
        t_start = time.perf_counter()

        # 1. Rules
        t_r0 = time.perf_counter()
        reasons = evaluate(txn, state=GLOBAL_STATE)
        rule_score = score_from_reasons(reasons)
        rules_latencies.append((time.perf_counter() - t_r0) * 1000.0)

        # 2. Graph cache & engine lookup
        t_g0 = time.perf_counter()
        graph_cache = GLOBAL_GRAPH.get_cache()
        graph_latencies.append((time.perf_counter() - t_g0) * 1000.0)

        # 3. Feature extraction
        t_fe0 = time.perf_counter()
        features = extract_features(txn, state=GLOBAL_STATE, graph_cache=graph_cache)
        extract_latencies.append((time.perf_counter() - t_fe0) * 1000.0)

        # 4. Individual specialist models
        t_s0 = time.perf_counter()
        s_sup = GLOBAL_ENSEMBLE.predict_supervised(features)
        sup_latencies.append((time.perf_counter() - t_s0) * 1000.0)

        t_a0 = time.perf_counter()
        s_anom = GLOBAL_ENSEMBLE.predict_anomaly(features)
        anom_latencies.append((time.perf_counter() - t_a0) * 1000.0)

        t_p0 = time.perf_counter()
        s_prof = GLOBAL_ENSEMBLE.predict_profile(txn)
        prof_latencies.append((time.perf_counter() - t_p0) * 1000.0)

        t_gm0 = time.perf_counter()
        s_graph = GLOBAL_ENSEMBLE.predict_graph(features)
        graph_mod_latencies.append((time.perf_counter() - t_gm0) * 1000.0)

        t_d0 = time.perf_counter()
        s_dev = GLOBAL_ENSEMBLE.predict_device(features)
        dev_latencies.append((time.perf_counter() - t_d0) * 1000.0)

        curr_time = parse_timestamp(txn.timestamp)
        t_m0 = time.perf_counter()
        s_mule = GLOBAL_ENSEMBLE.predict_mule(
            account_id=txn.sender_id,
            amount=float(txn.amount),
            current_time=curr_time,
            graph_cache=graph_cache,
        )
        mule_latencies.append((time.perf_counter() - t_m0) * 1000.0)

        # 5. Meta Model
        t_mt0 = time.perf_counter()
        _ = GLOBAL_ENSEMBLE.predict_meta(
            score_sup=s_sup,
            score_anom=s_anom,
            score_prof=s_prof,
            score_graph=s_graph,
            score_dev=s_dev,
            score_mule=s_mule,
            rule_score=rule_score,
        )
        meta_latencies.append((time.perf_counter() - t_mt0) * 1000.0)

        # Ingest to graph & update state (complete real pipeline work)
        GLOBAL_GRAPH.add_transaction(txn, risk=rule_score / 100.0)
        GLOBAL_ENSEMBLE.profile_model.update_account(txn.sender_id, float(txn.amount), txn.receiver_id)
        GLOBAL_ENSEMBLE.mule_tracker.update_transaction(txn, curr_time)

        t_total = (time.perf_counter() - t_start) * 1000.0
        total_latencies.append(t_total)

    result = {
        "transactions_tested": test_n,
        "warmup_transactions": warmup_n,
        "total_pipeline_ms": compute_percentiles(total_latencies),
        "stage_breakdown_ms": {
            "rules": compute_percentiles(rules_latencies),
            "graph_cache": compute_percentiles(graph_latencies),
            "feature_extraction": compute_percentiles(extract_latencies),
            "model_supervised_xgb": compute_percentiles(sup_latencies),
            "model_anomaly_iforest": compute_percentiles(anom_latencies),
            "model_behaviour_profile": compute_percentiles(prof_latencies),
            "model_graph_topological": compute_percentiles(graph_mod_latencies),
            "model_device_identity": compute_percentiles(dev_latencies),
            "model_mule_tracker": compute_percentiles(mule_latencies),
            "meta_learner": compute_percentiles(meta_latencies),
        },
    }
    print("   Total pipeline mean:", result["total_pipeline_ms"]["mean"], "ms (p95:", result["total_pipeline_ms"]["p95"], "ms, max:", result["total_pipeline_ms"]["max"], "ms)")
    return result


# ============================================================================
# Section 2: HTTP End-to-End Benchmark (300 POST /score calls)
# ============================================================================

def benchmark_http_score(num_requests: int = 300) -> Dict[str, Any]:
    print(f"\n[2/5] Benchmarking HTTP End-to-End POST /score ({num_requests} requests)...")
    client = TestClient(app)

    # 10 warmup requests
    for _ in range(10):
        t = normal_txn()
        client.post("/score", json=t.model_dump())

    http_times: List[float] = []
    for _ in range(num_requests):
        t = normal_txn()
        payload = t.model_dump()
        t0 = time.perf_counter()
        resp = client.post("/score", json=payload)
        elapsed = (time.perf_counter() - t0) * 1000.0
        if resp.status_code == 200:
            http_times.append(elapsed)

    result = {
        "requests_sent": num_requests,
        "requests_successful": len(http_times),
        "http_latency_ms": compute_percentiles(http_times),
    }
    print("   HTTP POST /score mean:", result["http_latency_ms"]["mean"], "ms (p95:", result["http_latency_ms"]["p95"], "ms, max:", result["http_latency_ms"]["max"], "ms)")
    return result


# ============================================================================
# Section 3: Graph Scale Benchmark (5,000 Accounts + Ring Detection)
# ============================================================================

def benchmark_graph_scale() -> Dict[str, Any]:
    print("\n[3/5] Benchmarking Graph Scale (5,000 accounts + 8-member ring injection)...")
    reset_global_system_state()
    checkpoints = [1000, 2500, 5000]
    checkpoint_results: Dict[str, Any] = {}

    accounts = [f"ACC_SCALE_{i:04d}" for i in range(5000)]
    np_rng = np.random.RandomState(42)

    current_account_idx = 0
    now_iso = datetime.now(timezone.utc).isoformat()

    for cp in checkpoints:
        # Ingest transactions into the REAL live pipeline until node count reaches checkpoint
        while len(GLOBAL_GRAPH.graph.nodes) < cp and current_account_idx < len(accounts) - 1:
            u = accounts[current_account_idx]
            fanout = int(np_rng.randint(1, 4))
            targets = np_rng.choice(accounts[: max(current_account_idx + 1, 2)], size=fanout)
            for v in targets:
                if u != v:
                    t = Transaction(
                        txn_id=f"TXN_SCALE_{uuid.uuid4().hex[:10]}",
                        timestamp=now_iso,
                        sender_id=u,
                        receiver_id=v,
                        amount=float(np_rng.uniform(100.0, 5000.0)),
                        device_id=f"DEV_{u}",
                        ip="10.0.0.1",
                        channel="UPI",
                    )
                    GLOBAL_GRAPH.add_transaction(t, risk=float(np_rng.uniform(0.01, 0.20)))
            current_account_idx += 1

        # Recompute graph cache at checkpoint milestone
        GLOBAL_GRAPH.recompute_cache()

        # Measure 50 test transactions using the SAME FULL scoring pipeline function as [1/5]
        test_times: List[float] = []
        for _ in range(50):
            sender = np_rng.choice(accounts[:current_account_idx])
            receiver = np_rng.choice(accounts[:current_account_idx])
            if sender == receiver:
                receiver = accounts[0]
            txn = Transaction(
                txn_id=f"TXN_CHECK_{uuid.uuid4().hex[:10]}",
                timestamp=now_iso,
                sender_id=sender,
                receiver_id=receiver,
                amount=750.0,
                device_id=f"DEV_{sender}",
                ip="10.0.0.1",
                channel="UPI",
            )
            t0 = time.perf_counter()
            _ = score_transaction(txn)
            test_times.append((time.perf_counter() - t0) * 1000.0)

        checkpoint_results[f"nodes_{cp}"] = {
            "actual_nodes": len(GLOBAL_GRAPH.graph.nodes),
            "actual_edges": len(GLOBAL_GRAPH.graph.edges),
            "full_pipeline_latency_ms": compute_percentiles(test_times),
        }
        res_pct = checkpoint_results[f"nodes_{cp}"]["full_pipeline_latency_ms"]
        print(f"   Checkpoint {cp} nodes: graph size={len(GLOBAL_GRAPH.graph.nodes)} nodes / {len(GLOBAL_GRAPH.graph.edges)} edges | full pipeline mean={res_pct['mean']} ms, p50={res_pct['p50']} ms, p95={res_pct['p95']} ms, p99={res_pct['p99']} ms, max={res_pct['max']} ms")

    # Code path disclosure for ring detection
    ring_detection_code_path = "app.graph_engine.GraphEngine.recompute_cache -> bounded cycles of length 3-8 on risk-filtered subgraph (risk >= 0.30), ring size cap 10 (oversized components -> dense_clusters)"
    print(f"\n   [Ring Detection Code Path]: {ring_detection_code_path}")
    print("   [Note]: Test is easy by construction: ring edges risk 0.85-0.90 vs background 0.01-0.20, filter threshold 0.30")

    # Inject an 8-member cash-out ring
    ring_members = [f"RING_INJECT_{i:02d}" for i in range(8)]
    cashout_hub = ring_members[-1]  # RING_INJECT_07 is cash-out hub

    # Circular loop between members 0 through 6
    for idx in range(7):
        nxt = (idx + 1) % 7
        t = Transaction(
            txn_id=f"TXN_RING_CYCLE_{idx}",
            timestamp=now_iso,
            sender_id=ring_members[idx],
            receiver_id=ring_members[nxt],
            amount=49000.0,
            device_id=f"DEV_RING_{idx}",
            ip="172.16.0.1",
            channel="UPI",
        )
        GLOBAL_GRAPH.add_transaction(t, risk=0.85)

    # Cash-out forwarding to hub (hub has in-edges from circle members)
    for idx in range(7):
        t = Transaction(
            txn_id=f"TXN_RING_CASHOUT_{idx}",
            timestamp=now_iso,
            sender_id=ring_members[idx],
            receiver_id=cashout_hub,
            amount=45000.0,
            device_id=f"DEV_RING_{idx}",
            ip="172.16.0.1",
            channel="UPI",
        )
        GLOBAL_GRAPH.add_transaction(t, risk=0.90)

    # Detect rings by executing the production graph engine recomputation
    cache = GLOBAL_GRAPH.recompute_cache()
    detected_rings = cache.get("rings", [])
    all_detected_ring_nodes: set = set()
    for r in detected_rings:
        for m in r.get("members", []):
            all_detected_ring_nodes.add(m)

    injected_set = set(ring_members)
    detected_injected = injected_set.intersection(all_detected_ring_nodes)
    innocent_accounts = [m for m in all_detected_ring_nodes if m not in injected_set]

    members_found = len(detected_injected)
    total_injected = len(ring_members)
    total_detected = len(all_detected_ring_nodes)
    innocent_count = len(innocent_accounts)

    recall = round(members_found / total_injected, 4) if total_injected > 0 else 0.0
    precision = round(members_found / total_detected, 4) if total_detected > 0 else 0.0
    innocent_rate = round(innocent_count / total_detected, 4) if total_detected > 0 else 0.0

    ring_result = {
        "code_path": ring_detection_code_path,
        "members_injected": total_injected,
        "members_found": members_found,
        "total_detected_in_all_rings": total_detected,
        "innocent_accounts_included": innocent_count,
        "recall": recall,
        "precision": precision,
        "innocent_accounts_ratio": innocent_rate,
        "detected_rings_count": len(detected_rings),
        "injected_members_found": sorted(list(detected_injected)),
        "innocent_sample": innocent_accounts[:10],
    }

    print(f"   Ring Detection Results:")
    print(f"     - Members found: {members_found}/{total_injected} (Recall: {recall*100:.2f}%)")
    print(f"     - Innocent accounts included: {innocent_count}/{total_detected} (Innocent ratio: {innocent_rate*100:.2f}%)")
    print(f"     - Precision: {precision*100:.2f}% ({members_found} true ring members / {total_detected} total ring members reported)")
    print(f"     - Total detected rings: {len(detected_rings)}")

    return {
        "checkpoints": checkpoint_results,
        "ring_injection_test": ring_result,
    }


# ============================================================================
# Section 4: Scenario Detection (Velocity, Ring, Fanout Cashout)
# ============================================================================

def benchmark_scenarios() -> Dict[str, Any]:
    print("\n[4/5] Benchmarking Fraud Scenario Detection...")
    scenarios = ["velocity_attack", "ring_attack", "fanout_cashout"]
    results: Dict[str, Any] = {}

    for name in scenarios:
        reset_global_system_state()
        if name == "velocity_attack":
            txns = velocity_attack()
        elif name == "ring_attack":
            txns = ring_attack()
        elif name == "fanout_cashout":
            txns = fanout_cashout()
        else:
            txns = []

        total = len(txns)
        allowed = 0
        reviewed = 0
        blocked = 0
        scores: List[int] = []

        for t in txns:
            res = score_transaction(t)
            scores.append(res.risk_score)
            if res.decision == "BLOCK":
                blocked += 1
            elif res.decision == "REVIEW":
                reviewed += 1
            else:
                allowed += 1

        flagged = reviewed + blocked
        pct_flagged = round((flagged / total) * 100.0, 1) if total > 0 else 0.0

        results[name] = {
            "total_transactions": total,
            "blocked": blocked,
            "reviewed": reviewed,
            "allowed": allowed,
            "total_flagged": flagged,
            "flagged_percent": pct_flagged,
            "mean_score": round(float(np.mean(scores)), 1) if scores else 0.0,
            "max_score": int(np.max(scores)) if scores else 0,
        }
        print(f"   {name}: {flagged}/{total} flagged ({pct_flagged}%) [BLOCK: {blocked}, REVIEW: {reviewed}, ALLOW: {allowed}, mean_score: {results[name]['mean_score']}]")

    return results


# ============================================================================
# Section 5: False Positive Rate Analysis
# ============================================================================

def benchmark_false_positives(sample_size: int = 200) -> Dict[str, Any]:
    print(f"\n[5/5] Benchmarking False Positives on Normal Transactions ({sample_size} txns)...")

    # (a) Cold Start right after reset
    reset_global_system_state()
    cold_scores: List[int] = []
    cold_reviewed = 0
    cold_blocked = 0

    for _ in range(sample_size):
        t = normal_txn()
        res = score_transaction(t)
        cold_scores.append(res.risk_score)
        if res.decision == "BLOCK":
            cold_blocked += 1
        elif res.decision == "REVIEW":
            cold_reviewed += 1

    cold_fps = cold_reviewed + cold_blocked
    cold_fp_rate = round((cold_fps / sample_size) * 100.0, 2)

    # (b) Warmed Baseline after 500 normal transactions
    reset_global_system_state()
    print("   Running 500 warmup transactions for baseline state...")
    for _ in range(500):
        t = normal_txn()
        _ = score_transaction(t)

    warm_scores: List[int] = []
    warm_reviewed = 0
    warm_blocked = 0

    for _ in range(sample_size):
        t = normal_txn()
        res = score_transaction(t)
        warm_scores.append(res.risk_score)
        if res.decision == "BLOCK":
            warm_blocked += 1
        elif res.decision == "REVIEW":
            warm_reviewed += 1

    warm_fps = warm_reviewed + warm_blocked
    warm_fp_rate = round((warm_fps / sample_size) * 100.0, 2)

    results = {
        "cold_start_after_reset": {
            "transactions_tested": sample_size,
            "review_count": cold_reviewed,
            "block_count": cold_blocked,
            "total_false_positives": cold_fps,
            "false_positive_rate_percent": cold_fp_rate,
            "mean_score": round(float(np.mean(cold_scores)), 2),
            "max_score": int(np.max(cold_scores)),
        },
        "warmed_baseline_after_500_txns": {
            "transactions_tested": sample_size,
            "review_count": warm_reviewed,
            "block_count": warm_blocked,
            "total_false_positives": warm_fps,
            "false_positive_rate_percent": warm_fp_rate,
            "mean_score": round(float(np.mean(warm_scores)), 2),
            "max_score": int(np.max(warm_scores)),
        },
    }
    print(f"   Cold Start FP Rate: {cold_fp_rate}% (Review: {cold_reviewed}, Block: {cold_blocked})")
    print(f"   Warmed Baseline FP Rate: {warm_fp_rate}% (Review: {warm_reviewed}, Block: {warm_blocked})")
    return results


# ============================================================================
# Main Runner & JSON Export
# ============================================================================

def main():
    timestamp_iso = datetime.now(timezone.utc).isoformat()
    system_metadata = {
        "timestamp_utc": timestamp_iso,
        "python_version": sys.version,
        "platform": platform.platform(),
        "libraries": {
            "xgboost": getattr(xgb, "__version__", "unknown"),
            "scikit_learn": getattr(sklearn, "__version__", "unknown"),
            "numpy": getattr(np, "__version__", "unknown"),
            "networkx": getattr(nx, "__version__", "unknown"),
            "pydantic": getattr(pydantic, "__version__", "unknown"),
            "uvicorn": getattr(uvicorn, "__version__", "unknown"),
        },
    }

    print("=" * 70)
    print("FraudShield Production Pipeline Audit & Benchmark")
    print(f"Date: {timestamp_iso}")
    print(f"Python: {sys.version.split()[0]} on {platform.system()} ({platform.machine()})")
    print(f"XGBoost: {system_metadata['libraries']['xgboost']} | scikit-learn: {system_metadata['libraries']['scikit_learn']} | NumPy: {system_metadata['libraries']['numpy']}")
    print("=" * 70)

    # 1. Pipeline micro-benchmark
    sec1 = benchmark_pipeline_latency(warmup_n=200, test_n=2000)

    # 2. HTTP end-to-end benchmark
    sec2 = benchmark_http_score(num_requests=300)

    # 3. Graph Scale & Ring Detection
    sec3 = benchmark_graph_scale()

    # 4. Scenario Detection
    sec4 = benchmark_scenarios()

    # 5. False Positives
    sec5 = benchmark_false_positives(sample_size=200)

    final_report = {
        "metadata": system_metadata,
        "pipeline_latency": sec1,
        "http_end_to_end": sec2,
        "graph_scale_and_ring_detection": sec3,
        "scenario_detection": sec4,
        "false_positive_rates": sec5,
    }

    # Save to docs/audit_benchmark.json
    docs_dir = os.path.join(BACKEND_DIR, "..", "docs")
    os.makedirs(docs_dir, exist_ok=True)
    out_path = os.path.join(docs_dir, "audit_benchmark.json")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(final_report, f, indent=2)

    print("\n" + "=" * 70)
    print(f"Audit Benchmark complete. Raw data saved to: {os.path.abspath(out_path)}")
    print("=" * 70)


if __name__ == "__main__":
    main()
