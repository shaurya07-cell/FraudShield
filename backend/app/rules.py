"""Rule-based fraud detection engine."""
from typing import List, Optional

from app.schemas import Reason, Transaction
from app.state import EngineState, GLOBAL_STATE, parse_timestamp


def score_from_reasons(reasons: List[Reason]) -> int:
    """Calculate capped risk score (0-100) from triggered reasons."""
    total = sum(r.weight for r in reasons)
    return min(total, 100)


def evaluate(txn: Transaction, state: Optional[EngineState] = None) -> List[Reason]:
    """Evaluate all 7 fraud rules against in-memory state and update state."""
    if state is None:
        state = GLOBAL_STATE

    current_time = parse_timestamp(txn.timestamp)
    reasons: List[Reason] = []

    with state._lock:
        sender_acc = state.accounts.get(txn.sender_id)
        receiver_acc = state.accounts.get(txn.receiver_id)

        # 1. VELOCITY_BURST: more than 8 txns by sender in 60 s (weight 30)
        recent_60s_count = 0
        if sender_acc is not None:
            cutoff_60s = current_time - 60.0
            for t_stamp, _ in reversed(sender_acc.sent_window):
                if t_stamp >= cutoff_60s:
                    recent_60s_count += 1
                else:
                    break
        # Including current txn
        if recent_60s_count + 1 > 8:
            reasons.append(
                Reason(
                    rule="VELOCITY_BURST",
                    detail=f"Sender {txn.sender_id} has {recent_60s_count + 1} transactions in 60s (threshold > 8)",
                    weight=30,
                )
            )

        # 2. AMOUNT_SPIKE: amount > 5x sender's running average, needs at least 5 prior txns (weight 20)
        if sender_acc is not None and sender_acc.total_sent_count >= 5:
            avg_amt = sender_acc.running_avg
            if txn.amount > 5.0 * avg_amt:
                reasons.append(
                    Reason(
                        rule="AMOUNT_SPIKE",
                        detail=f"Amount {txn.amount:.2f} is >5x running average {avg_amt:.2f} ({sender_acc.total_sent_count} prior txns)",
                        weight=20,
                    )
                )

        # 3. NEW_ACCOUNT_RISK: sender first seen under 10 minutes ago and amount > 3000 (weight 15)
        first_seen = sender_acc.first_seen if sender_acc is not None else current_time
        age_seconds = current_time - first_seen
        if age_seconds < 600.0 and txn.amount > 3000.0:
            reasons.append(
                Reason(
                    rule="NEW_ACCOUNT_RISK",
                    detail=f"Sender {txn.sender_id} first seen {age_seconds:.1f}s ago (<10m) with high amount {txn.amount:.2f}",
                    weight=15,
                )
            )

        # 4. SHARED_DEVICE: device used by 3 or more distinct accounts (weight 25)
        existing_device_accounts = state.device_accounts.get(txn.device_id, set())
        device_accounts_count = len(existing_device_accounts | {txn.sender_id})
        if device_accounts_count >= 3:
            reasons.append(
                Reason(
                    rule="SHARED_DEVICE",
                    detail=f"Device {txn.device_id} used by {device_accounts_count} distinct accounts (threshold >= 3)",
                    weight=25,
                )
            )

        # 5. FAN_IN: receiver got payments from 6 or more distinct senders in 5 minutes (weight 25)
        distinct_senders = {txn.sender_id}
        if receiver_acc is not None:
            cutoff_300s = current_time - 300.0
            for t_stamp, s_id in reversed(receiver_acc.received_window):
                if t_stamp >= cutoff_300s:
                    distinct_senders.add(s_id)
                else:
                    break
        if len(distinct_senders) >= 6:
            reasons.append(
                Reason(
                    rule="FAN_IN",
                    detail=f"Receiver {txn.receiver_id} received from {len(distinct_senders)} distinct senders in 5m (threshold >= 6)",
                    weight=25,
                )
            )

        # 6. ROUND_TRIP: receiver sent money to sender within the last 5 minutes (weight 20)
        # Checked via state helper (direct or graph cycle within 5 min)
        if state.check_round_trip(txn.sender_id, txn.receiver_id, current_time, window_seconds=300.0):
            reasons.append(
                Reason(
                    rule="ROUND_TRIP",
                    detail=f"Receiver {txn.receiver_id} sent funds back to {txn.sender_id} within 5m",
                    weight=20,
                )
            )

        # 7. STRUCTURING: 3 or more txns by sender in 10 minutes, each between 90% and 100% of 5000 (weight 25)
        structuring_count = 1 if (4500.0 <= txn.amount <= 5000.0) else 0
        if sender_acc is not None:
            cutoff_600s = current_time - 600.0
            for t_stamp, amt in reversed(sender_acc.sent_window):
                if t_stamp >= cutoff_600s:
                    if 4500.0 <= amt <= 5000.0:
                        structuring_count += 1
                else:
                    break
        if structuring_count >= 3:
            reasons.append(
                Reason(
                    rule="STRUCTURING",
                    detail=f"Sender {txn.sender_id} made {structuring_count} txns between 4500 and 5000 in 10m (threshold >= 3)",
                    weight=25,
                )
            )

    # Amortized O(1) state update
    state.update(txn)

    return reasons
