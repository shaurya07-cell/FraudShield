"""In-memory per-account state and network mappings for FraudShield."""
from collections import defaultdict, deque
from datetime import datetime
import threading
import time
from typing import Dict, List, Optional, Set, Tuple

from app.schemas import Transaction


def parse_timestamp(ts: str) -> float:
    """Parse ISO-8601 string to epoch seconds float."""
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts).timestamp()
    except Exception:
        return time.time()


class AccountState:
    """Per-account sliding window and historical statistics."""

    __slots__ = (
        "account_id",
        "first_seen",
        "total_sent_count",
        "total_sent_amount",
        "sent_window",
        "received_window",
        "received_amounts",
        "receivers",
    )

    def __init__(self, account_id: str, first_seen: float):
        self.account_id: str = account_id
        self.first_seen: float = first_seen
        self.total_sent_count: int = 0
        self.total_sent_amount: float = 0.0
        # deque of (timestamp, amount) for sent txns (pruned to 10 min window)
        self.sent_window: deque[Tuple[float, float]] = deque()
        # deque of (timestamp, sender_id) for received txns (pruned to 5 min window)
        self.received_window: deque[Tuple[float, str]] = deque()
        # deque of (timestamp, amount) for received amounts (pruned to 5 min window)
        self.received_amounts: deque[Tuple[float, float]] = deque()
        # set of all distinct receivers sent to
        self.receivers: Set[str] = set()

    @property
    def running_avg(self) -> float:
        if self.total_sent_count == 0:
            return 0.0
        return self.total_sent_amount / self.total_sent_count

    def prune(self, current_time: float) -> None:
        """Prune sent window older than 10 mins (600s) and received window older than 5 mins (300s)."""
        sent_cutoff = current_time - 600.0
        while self.sent_window and self.sent_window[0][0] < sent_cutoff:
            self.sent_window.popleft()

        received_cutoff = current_time - 300.0
        while self.received_window and self.received_window[0][0] < received_cutoff:
            self.received_window.popleft()
        while self.received_amounts and self.received_amounts[0][0] < received_cutoff:
            self.received_amounts.popleft()


class EngineState:
    """Thread-safe in-memory state for real-time fraud scoring."""

    def __init__(self):
        self._lock = threading.RLock()
        self.accounts: Dict[str, AccountState] = {}
        self.device_accounts: Dict[str, Set[str]] = defaultdict(set)
        self.ip_accounts: Dict[str, Set[str]] = defaultdict(set)
        # (sender, receiver) -> timestamp of most recent transaction
        self.pair_times: Dict[Tuple[str, str], float] = {}
        # sender -> {receiver: timestamp} for fast cycle/round-trip traversal
        self.pair_graph: Dict[str, Dict[str, float]] = defaultdict(dict)
        self.seen_txn_ids: Set[str] = set()

    def reset(self) -> None:
        """Clear all in-memory state."""
        with self._lock:
            self.accounts.clear()
            self.device_accounts.clear()
            self.ip_accounts.clear()
            self.pair_times.clear()
            self.pair_graph.clear()
            self.seen_txn_ids.clear()

    def get_or_create_account(self, account_id: str, current_time: float) -> AccountState:
        """Retrieve existing account or initialize with current timestamp."""
        acc = self.accounts.get(account_id)
        if acc is None:
            acc = AccountState(account_id=account_id, first_seen=current_time)
            self.accounts[account_id] = acc
        return acc

    def update(self, txn: Transaction) -> None:
        """Update in-memory state with transaction details in O(1) amortized time."""
        current_time = parse_timestamp(txn.timestamp)

        with self._lock:
            if txn.txn_id in self.seen_txn_ids:
                return
            self.seen_txn_ids.add(txn.txn_id)

            # Sender state
            sender_acc = self.get_or_create_account(txn.sender_id, current_time)
            sender_acc.prune(current_time)
            sender_acc.total_sent_count += 1
            sender_acc.total_sent_amount += txn.amount
            sender_acc.sent_window.append((current_time, txn.amount))
            sender_acc.receivers.add(txn.receiver_id)

            # Receiver state
            receiver_acc = self.get_or_create_account(txn.receiver_id, current_time)
            receiver_acc.prune(current_time)
            receiver_acc.received_window.append((current_time, txn.sender_id))
            receiver_acc.received_amounts.append((current_time, txn.amount))

            # Device and IP maps
            self.device_accounts[txn.device_id].add(txn.sender_id)
            self.ip_accounts[txn.ip].add(txn.sender_id)

            # (sender, receiver) pair records
            self.pair_times[(txn.sender_id, txn.receiver_id)] = current_time
            self.pair_graph[txn.sender_id][txn.receiver_id] = current_time

    def check_round_trip(self, sender_id: str, receiver_id: str, current_time: float, window_seconds: float = 300.0) -> bool:
        """Check if receiver sent to sender directly or via recent transaction chain within window."""
        with self._lock:
            cutoff = current_time - window_seconds

            # 1. Direct check: Did receiver send to sender recently?
            direct_time = self.pair_times.get((receiver_id, sender_id))
            if direct_time is not None and direct_time >= cutoff:
                return True

            # 2. Path check (BFS up to depth 5): Does receiver reach sender through recent payments?
            visited = {receiver_id}
            queue = deque([(receiver_id, 0)])

            while queue:
                curr, depth = queue.popleft()
                if depth >= 5:
                    continue
                neighbors = self.pair_graph.get(curr, {})
                for next_acc, edge_time in neighbors.items():
                    if edge_time >= cutoff:
                        if next_acc == sender_id:
                            return True
                        if next_acc not in visited:
                            visited.add(next_acc)
                            queue.append((next_acc, depth + 1))

            return False


# Singleton engine state instance
GLOBAL_STATE = EngineState()


def reset() -> None:
    """Module-level reset convenience function."""
    GLOBAL_STATE.reset()
