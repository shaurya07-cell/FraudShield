"""In-memory metrics collector and real-time transaction store for FraudShield."""
from collections import deque
import threading
import time
from typing import Any, Dict, List, Set

import numpy as np

from app.schemas import ScoredTransaction


class MetricsCollector:
    """Thread-safe collector for real-time traffic statistics and recent transactions.

    Performs all operations purely in-memory with no network or disk I/O.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self.total_txns: int = 0
        self.allowed: int = 0
        self.review: int = 0
        self.blocked: int = 0
        self.rings_detected: int = 0
        self.seen_rings: Set[str] = set()

        # Last 5000 latencies for avg and p99 calculation
        self.latencies: deque = deque(maxlen=5000)

        # Last 500 scored transactions for graph generation
        self.recent_txns: deque = deque(maxlen=500)

        # Timestamps of transactions within the last 10 seconds for TPS
        self.txn_timestamps: deque = deque()

    def update(self, scored_txn: ScoredTransaction) -> None:
        """Update metrics with a newly scored transaction in O(1) time."""
        now = time.time()
        with self._lock:
            self.total_txns += 1
            if scored_txn.decision == "ALLOW":
                self.allowed += 1
            elif scored_txn.decision == "REVIEW":
                self.review += 1
            elif scored_txn.decision == "BLOCK":
                self.blocked += 1

            # Track detected ring IDs
            if scored_txn.ring_id and scored_txn.ring_id not in self.seen_rings:
                self.seen_rings.add(scored_txn.ring_id)
                self.rings_detected += 1

            self.latencies.append(scored_txn.latency_ms)
            self.recent_txns.append(scored_txn)
            self.txn_timestamps.append(now)

            # Prune timestamps older than 10 seconds
            cutoff = now - 10.0
            while self.txn_timestamps and self.txn_timestamps[0] < cutoff:
                self.txn_timestamps.popleft()

    def register_ring(self, ring_id: str) -> None:
        """Register a ring detected out-of-band by the graph engine."""
        with self._lock:
            if ring_id and ring_id not in self.seen_rings:
                self.seen_rings.add(ring_id)
                self.rings_detected += 1

    def get_metrics(self) -> Dict[str, Any]:
        """Return rolling traffic statistics and latency percentiles."""
        now = time.time()
        with self._lock:
            # Prune timestamps older than 10s
            cutoff = now - 10.0
            while self.txn_timestamps and self.txn_timestamps[0] < cutoff:
                self.txn_timestamps.popleft()

            # Calculate rolling TPS over the 10-second window
            tps = len(self.txn_timestamps) / 10.0 if self.total_txns > 0 else 0.0

            if self.latencies:
                lats = list(self.latencies)
                avg_lat = float(np.mean(lats))
                p99_lat = float(np.percentile(lats, 99))
            else:
                avg_lat = 0.0
                p99_lat = 0.0

            return {
                "total_txns": self.total_txns,
                "avg_latency_ms": round(avg_lat, 3),
                "p99_latency_ms": round(p99_lat, 3),
                "tps": round(tps, 2),
                "allowed": self.allowed,
                "review": self.review,
                "blocked": self.blocked,
                "rings_detected": self.rings_detected,
            }

    def get_recent_transactions(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Return the last N scored transactions as serialized dictionaries."""
        with self._lock:
            txns = list(self.recent_txns)[-limit:]
            # Return in reverse chronological order (newest first)
            return [t.model_dump() for t in reversed(txns)]

    def get_recent_scored_transactions(self) -> List[ScoredTransaction]:
        """Return raw list of up to 500 recent scored transactions."""
        with self._lock:
            return list(self.recent_txns)

    def reset(self) -> None:
        """Clear all metrics counters, latencies, and transaction history."""
        with self._lock:
            self.total_txns = 0
            self.allowed = 0
            self.review = 0
            self.blocked = 0
            self.rings_detected = 0
            self.seen_rings.clear()
            self.latencies.clear()
            self.recent_txns.clear()
            self.txn_timestamps.clear()


# Global singleton metrics collector
METRICS = MetricsCollector()
