import pytest
from app.simulator import (
    FRAUD_TXN_IDS,
    normal_txn,
    velocity_attack,
    ring_attack,
    fanout_cashout,
    scenario,
    HONEST_ACCOUNTS,
    FRAUD_ACCOUNTS,
)


def test_velocity_attack_produces_15_txns_from_one_sender():
    txns = velocity_attack(n=15)

    assert len(txns) == 15

    # Exactly one unique sender from fraud pool
    senders = {t.sender_id for t in txns}
    assert len(senders) == 1
    sender = next(iter(senders))
    assert sender in FRAUD_ACCOUNTS

    # 15 distinct honest receivers
    receivers = [t.receiver_id for t in txns]
    assert len(set(receivers)) == 15
    for receiver in receivers:
        assert receiver in HONEST_ACCOUNTS

    # Check amounts and fraud IDs
    for t in txns:
        assert 4800.0 <= t.amount <= 4999.0
        assert t.txn_id in FRAUD_TXN_IDS


def test_ring_attack_produces_cycle_of_5_distinct_accounts():
    size = 5
    laps = 3
    txns = ring_attack(size=size, laps=laps)

    assert len(txns) == size * laps

    # Exactly 5 distinct accounts involved
    all_accounts = {t.sender_id for t in txns} | {t.receiver_id for t in txns}
    assert len(all_accounts) == 5
    for acc in all_accounts:
        assert acc in FRAUD_ACCOUNTS

    # Single shared device ID
    device_ids = {t.device_id for t in txns}
    assert len(device_ids) == 1

    # Verify cycle structure: hop i connects to hop (i+1) % size
    for lap in range(laps):
        lap_txns = txns[lap * size : (lap + 1) * size]
        for i in range(size):
            curr_txn = lap_txns[i]
            next_txn = lap_txns[(i + 1) % size]
            assert curr_txn.receiver_id == next_txn.sender_id

    # Verify all transaction IDs are marked in FRAUD_TXN_IDS
    for t in txns:
        assert t.txn_id in FRAUD_TXN_IDS


def test_all_fraud_txns_in_fraud_txn_ids():
    initial_count = len(FRAUD_TXN_IDS)

    vel_txns = velocity_attack(n=15)
    for t in vel_txns:
        assert t.txn_id in FRAUD_TXN_IDS

    ring_txns = ring_attack(size=5, laps=2)
    for t in ring_txns:
        assert t.txn_id in FRAUD_TXN_IDS

    cashout_txns = fanout_cashout(mules=4)
    for t in cashout_txns:
        assert t.txn_id in FRAUD_TXN_IDS

    # Normal transaction is NOT flagged in FRAUD_TXN_IDS
    norm_txn = normal_txn()
    assert norm_txn.txn_id not in FRAUD_TXN_IDS


def test_scenario_dispatch():
    normal_txns = scenario("normal")
    assert len(normal_txns) == 50
    assert all(t.sender_id in HONEST_ACCOUNTS for t in normal_txns)

    vel_txns = scenario("velocity_attack")
    assert len(vel_txns) == 15

    ring_txns = scenario("ring_attack")
    assert len(ring_txns) == 15  # default size=5, laps=3

    fanout_txns = scenario("fanout_cashout")
    assert len(fanout_txns) == 16  # 8 victim->mule, 8 mule->cashout

    bulk_txns = scenario("bulk_payer")
    assert len(bulk_txns) == 15
    assert all(t.txn_id.startswith("TXN_PAY_") for t in bulk_txns)

    with pytest.raises(ValueError):
        scenario("unsupported_scenario")


def test_normal_scenario_warmed_up_state_and_sender_limit():
    """Verify normal scenario has <= 6 txns per sender and flags < 10% on warmed-up state."""
    import random
    random.seed(42)

    from collections import Counter
    from app.scorer import score_transaction
    from app.state import reset

    # Call scenario("normal") from this test (generates the full 50-transaction batch)
    txns = scenario("normal")
    assert len(txns) == 50

    # Verify no sender makes more than 6 transactions
    senders = Counter(t.sender_id for t in txns)
    max_sender_txns = max(senders.values())
    assert max_sender_txns <= 6, f"Expected sender txns <= 6, got {max_sender_txns}"

    # Verify all amounts are modest retail payments (< 10000)
    for t in txns:
        assert t.amount < 10000.0, f"Expected retail amount < 10000, got {t.amount}"

    # Warm up state so accounts have history and are not treated as brand-new
    reset()
    for _ in range(80):
        t = normal_txn()
        t.timestamp = "2026-01-01T00:00:00+00:00"
        score_transaction(t)

    # Score the normal scenario transactions
    flagged = 0
    for t in txns:
        scored = score_transaction(t)
        if scored.decision in ("REVIEW", "BLOCK"):
            flagged += 1

    flagged_ratio = flagged / len(txns)
    assert flagged_ratio < 0.10, f"Expected < 10% flagged, got {flagged}/{len(txns)} ({flagged_ratio:.1%})"


def test_bulk_payer_scenario_behavior():
    """Verify bulk_payer scenario generates large payments from one sender and flags for review."""
    from app.scorer import score_transaction
    from app.state import reset

    txns = scenario("bulk_payer")
    assert len(txns) >= 12

    # Exactly one sender paying many receivers large amounts
    senders = {t.sender_id for t in txns}
    assert len(senders) == 1, f"Expected 1 employer sender, got {senders}"
    receivers = {t.receiver_id for t in txns}
    assert len(receivers) == len(txns), "Expected all distinct employee receivers"

    # Large payroll amounts (>= 15000)
    for t in txns:
        assert t.amount >= 15000.0, f"Expected payroll amount >= 15000, got {t.amount}"

    # On a fresh state, the rapid high-amount fan-out flags for review/block
    reset()
    decisions = [score_transaction(t).decision for t in txns]
    assert any(d in ("REVIEW", "BLOCK") for d in decisions), "Bulk payer pattern should be flagged for review"

