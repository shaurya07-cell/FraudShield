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
    assert len(normal_txns) == 1
    assert normal_txns[0].sender_id in HONEST_ACCOUNTS

    vel_txns = scenario("velocity_attack")
    assert len(vel_txns) == 15

    ring_txns = scenario("ring_attack")
    assert len(ring_txns) == 15  # default size=5, laps=3

    fanout_txns = scenario("fanout_cashout")
    assert len(fanout_txns) == 16  # 8 victim->mule, 8 mule->cashout

    with pytest.raises(ValueError):
        scenario("unsupported_scenario")
