"""Benchmark evaluate() performance over 10,000 transactions."""
import time
from app.rules import evaluate
from app.simulator import normal_txn
from app.state import EngineState


def benchmark(num_calls: int = 10_000) -> float:
    state = EngineState()
    # Pre-generate 10,000 transactions to isolate evaluate() execution time
    txns = [normal_txn() for _ in range(num_calls)]

    start_time = time.perf_counter()
    for txn in txns:
        evaluate(txn, state)
    total_time = time.perf_counter() - start_time

    avg_ms = (total_time / num_calls) * 1000.0
    ops_per_sec = num_calls / total_time
    print(f"Total time for {num_calls:,} calls: {total_time:.4f} s")
    print(f"Average time per evaluate(): {avg_ms:.4f} ms")
    print(f"Throughput: {ops_per_sec:,.0f} ops/sec")
    return avg_ms


if __name__ == "__main__":
    benchmark(10_000)
