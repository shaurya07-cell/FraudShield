"""FraudShield Performance & Accuracy Benchmark.

Evaluates latency, throughput, precision, and recall across normal
transactions and simulated fraud attack scenarios.
"""
import datetime
import os
import platform
import sys
import time
from typing import List, Tuple

import numpy as np

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.rules import evaluate, score_from_reasons
from app.schemas import Transaction
from app.simulator import (
    FRAUD_TXN_IDS,
    fanout_cashout,
    normal_txn,
    ring_attack,
    velocity_attack,
)
from app.state import EngineState


def run_benchmark(
    num_normal: int = 10_000,
) -> Tuple[dict, dict]:
    """Run benchmark measuring latency, throughput, precision, and recall."""
    state = EngineState()
    base_time = datetime.datetime(2026, 11, 27, 10, 0, 0, tzinfo=datetime.timezone.utc)

    # 1. Generate normal transactions with realistic 1-2s spacing
    txns: List[Transaction] = []
    for i in range(num_normal):
        t = normal_txn()
        t.timestamp = (base_time + datetime.timedelta(seconds=i * 1.5)).isoformat()
        txns.append(t)

    # 2. Inject attack scenarios
    vel = velocity_attack(n=15)
    for i, t in enumerate(vel):
        t.timestamp = (base_time + datetime.timedelta(seconds=2000 + i * 2)).isoformat()
    txns.extend(vel)

    ring = ring_attack(size=5, laps=3)
    for i, t in enumerate(ring):
        t.timestamp = (base_time + datetime.timedelta(seconds=5000 + i * 4)).isoformat()
    txns.extend(ring)

    fanout = fanout_cashout(mules=8)
    for i, t in enumerate(fanout):
        t.timestamp = (base_time + datetime.timedelta(seconds=8000 + i * 2)).isoformat()
    txns.extend(fanout)

    # Sort transactions chronologically
    txns.sort(key=lambda x: x.timestamp)
    total_txns = len(txns)

    # 3. Execution & latency profiling
    latencies: List[float] = []
    y_true: List[int] = []
    y_pred: List[int] = []

    start_total = time.perf_counter()
    for txn in txns:
        t0 = time.perf_counter()
        reasons = evaluate(txn, state)
        lat_ms = (time.perf_counter() - t0) * 1000.0
        latencies.append(lat_ms)

        is_fraud = txn.txn_id in FRAUD_TXN_IDS
        score = score_from_reasons(reasons)
        is_flagged = score >= 40  # REVIEW or BLOCK

        y_true.append(1 if is_fraud else 0)
        y_pred.append(1 if is_flagged else 0)

    total_duration = time.perf_counter() - start_total

    latencies_arr = np.array(latencies)
    avg_latency = float(np.mean(latencies_arr))
    p50_latency = float(np.percentile(latencies_arr, 50))
    p95_latency = float(np.percentile(latencies_arr, 95))
    p99_latency = float(np.percentile(latencies_arr, 99))
    throughput = total_txns / total_duration

    tp = sum(yt == 1 and yp == 1 for yt, yp in zip(y_true, y_pred))
    fp = sum(yt == 0 and yp == 1 for yt, yp in zip(y_true, y_pred))
    fn = sum(yt == 1 and yp == 0 for yt, yp in zip(y_true, y_pred))
    tn = sum(yt == 0 and yp == 0 for yt, yp in zip(y_true, y_pred))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0

    system_info = {
        "platform": platform.platform(),
        "processor": platform.processor(),
        "python_version": platform.python_version(),
    }

    metrics = {
        "total_transactions": total_txns,
        "avg_latency_ms": avg_latency,
        "p50_latency_ms": p50_latency,
        "p95_latency_ms": p95_latency,
        "p99_latency_ms": p99_latency,
        "throughput_tps": throughput,
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "true_negatives": tn,
        "precision": precision,
        "recall": recall,
        "f1_score": f1,
    }

    return metrics, system_info


if __name__ == "__main__":
    metrics, sys_info = run_benchmark(num_normal=10_000)
    print("=" * 60)
    print("FraudShield Real-Time Engine Benchmark")
    print("=" * 60)
    print(f"OS / Platform       : {sys_info['platform']}")
    print(f"Processor           : {sys_info['processor']}")
    print(f"Python Version      : {sys_info['python_version']}")
    print(f"Total Transactions  : {metrics['total_transactions']:,}")
    print("-" * 60)
    print(f"Average Latency     : {metrics['avg_latency_ms']:.4f} ms")
    print(f"P50 Latency         : {metrics['p50_latency_ms']:.4f} ms")
    print(f"P95 Latency         : {metrics['p95_latency_ms']:.4f} ms")
    print(f"P99 Latency         : {metrics['p99_latency_ms']:.4f} ms")
    print(f"Throughput          : {metrics['throughput_tps']:,.0f} TPS")
    print("-" * 60)
    print(f"Precision           : {metrics['precision']:.4f} ({metrics['precision']*100:.2f}%)")
    print(f"Recall              : {metrics['recall']:.4f} ({metrics['recall']*100:.2f}%)")
    print(f"F1 Score            : {metrics['f1_score']:.4f}")
    print(f"Confusion Matrix    : TP={metrics['true_positives']}, FP={metrics['false_positives']}, FN={metrics['false_negatives']}, TN={metrics['true_negatives']}")
    print("=" * 60)
