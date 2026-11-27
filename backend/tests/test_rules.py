import pytest
from app.rules import evaluate, score_from_reasons
from app.schemas import Reason
from app.simulator import fanout_cashout, normal_txn, ring_attack, velocity_attack
from app.state import GLOBAL_STATE, reset


def test_velocity_attack_triggers_velocity_burst_and_structuring():
    reset()
    txns = velocity_attack(n=15)
    triggered_rules = set()

    for txn in txns:
        reasons = evaluate(txn, GLOBAL_STATE)
        for r in reasons:
            triggered_rules.add(r.rule)

    assert "VELOCITY_BURST" in triggered_rules
    assert "STRUCTURING" in triggered_rules


def test_ring_attack_triggers_shared_device_and_round_trip():
    reset()
    txns = ring_attack(size=5, laps=3)
    triggered_rules = set()

    for txn in txns:
        reasons = evaluate(txn, GLOBAL_STATE)
        for r in reasons:
            triggered_rules.add(r.rule)

    assert "SHARED_DEVICE" in triggered_rules
    assert "ROUND_TRIP" in triggered_rules


def test_fanout_cashout_triggers_fan_in():
    reset()
    txns = fanout_cashout(mules=8)
    triggered_rules = set()

    for txn in txns:
        reasons = evaluate(txn, GLOBAL_STATE)
        for r in reasons:
            triggered_rules.add(r.rule)

    assert "FAN_IN" in triggered_rules


def test_normal_txns_produce_fewer_than_5_percent_flagged():
    reset()
    total_txns = 200
    flagged = 0

    for _ in range(total_txns):
        txn = normal_txn()
        reasons = evaluate(txn, GLOBAL_STATE)
        score = score_from_reasons(reasons)
        if score >= 40:
            flagged += 1

    flag_rate = flagged / total_txns
    assert flag_rate < 0.05, f"Flag rate was {flag_rate:.2%}, expected < 5%"


def test_score_from_reasons_capped_at_100():
    reasons = [
        Reason(rule="R1", detail="", weight=50),
        Reason(rule="R2", detail="", weight=40),
        Reason(rule="R3", detail="", weight=30),
    ]
    assert score_from_reasons(reasons) == 100

    reasons_low = [
        Reason(rule="R1", detail="", weight=20),
        Reason(rule="R2", detail="", weight=15),
    ]
    assert score_from_reasons(reasons_low) == 35
