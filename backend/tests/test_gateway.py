"""Unit and integration tests for FraudShield Gateway."""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_all_state():
    """Reset all state, metrics, graph, and gateway balances before every test."""
    client.post("/reset")


def test_normal_payment_succeeds_and_updates_balances():
    """Verify normal payment succeeds with status SUCCESS and debit/credit balances."""
    sender_before = client.get("/gateway/accounts/ACC_0010").json()
    receiver_before = client.get("/gateway/accounts/ACC_0020").json()

    s_bal_init = sender_before["balance"]
    r_bal_init = receiver_before["balance"]
    transfer_amount = 500.0

    payload = {
        "from_account": "ACC_0010",
        "to_account": "ACC_0020",
        "amount": transfer_amount,
        "note": "Dinner bill",
    }
    response = client.post("/gateway/pay", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "SUCCESS"
    assert data["decision"] == "ALLOW"
    assert data["risk_score"] < 40
    assert data["sender_balance_after"] == round(s_bal_init - transfer_amount, 2)
    assert data["receiver_balance_after"] == round(r_bal_init + transfer_amount, 2)
    assert "payment_id" in data
    assert data["payment_id"].startswith("PAY_")
    assert data["fraud_check_ms"] > 0
    assert data["total_ms"] > 0

    # Verify accounts endpoint reflects new balances
    sender_after = client.get("/gateway/accounts/ACC_0010").json()
    receiver_after = client.get("/gateway/accounts/ACC_0020").json()
    assert sender_after["balance"] == round(s_bal_init - transfer_amount, 2)
    assert receiver_after["balance"] == round(r_bal_init + transfer_amount, 2)


def test_insufficient_funds_fails_without_fraud_check():
    """Verify overdraft attempts fail with status FAILED and balances remain unchanged."""
    sender = client.get("/gateway/accounts/ACC_0010").json()
    receiver = client.get("/gateway/accounts/ACC_0020").json()

    s_bal = sender["balance"]
    r_bal = receiver["balance"]
    excessive_amount = s_bal + 50000.0

    payload = {
        "from_account": "ACC_0010",
        "to_account": "ACC_0020",
        "amount": excessive_amount,
    }
    response = client.post("/gateway/pay", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "FAILED"
    assert data["decision"] is None
    assert data["risk_score"] == 0
    assert data["fraud_check_ms"] == 0.0
    assert "Insufficient funds" in data["message"]

    # Verify balances unchanged
    s_after = client.get("/gateway/accounts/ACC_0010").json()
    r_after = client.get("/gateway/accounts/ACC_0020").json()
    assert s_after["balance"] == s_bal
    assert r_after["balance"] == r_bal


def test_flagged_payment_declined_and_balances_unchanged():
    """Verify that high-risk payment from a flagged account is DECLINED and balances do not change."""
    # First, run velocity_attack scenario on backend so the fraud account is primed
    client.post("/simulate/velocity_attack")
    recent = client.get("/transactions/recent").json()
    flagged_sender = recent[0]["sender_id"]

    sender = client.get(f"/gateway/accounts/{flagged_sender}").json()
    receiver = client.get("/gateway/accounts/ACC_0005").json()
    s_bal = sender["balance"]
    r_bal = receiver["balance"]

    payload = {
        "from_account": flagged_sender,
        "to_account": "ACC_0005",
        "amount": 4900.0,
    }
    response = client.post("/gateway/pay", json=payload)
    assert response.status_code == 200
    data = response.json()

    assert data["status"] == "DECLINED"
    assert data["decision"] == "BLOCK"
    assert data["risk_score"] >= 70
    assert data["receiver_balance_after"] is None
    assert "Payment blocked" in data["message"]

    # Balances must remain unchanged
    s_after = client.get(f"/gateway/accounts/{flagged_sender}").json()
    r_after = client.get("/gateway/accounts/ACC_0005").json()
    assert s_after["balance"] == s_bal
    assert r_after["balance"] == r_bal


def test_review_payment_pending_and_confirmed_with_otp():
    """Verify a REVIEW payment stays pending until confirmed with valid demo OTP."""
    sender_init = client.get("/gateway/accounts/ACC_0405").json()["balance"]
    receiver_init = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    transfer_amount = 4950.0

    res = client.post("/gateway/pay", json={
        "from_account": "ACC_0405",
        "to_account": "ACC_0010",
        "amount": transfer_amount,
    })
    assert res.status_code == 200
    pay_data = res.json()

    # Lands in REVIEW with PENDING_VERIFICATION and demo OTP
    assert pay_data["decision"] == "REVIEW"
    assert pay_data["status"] == "PENDING_VERIFICATION"
    assert pay_data["demo_otp"] is not None
    assert len(pay_data["demo_otp"]) == 6
    payment_id = pay_data["payment_id"]

    # Balances should not move while pending
    s_pending = client.get("/gateway/accounts/ACC_0405").json()["balance"]
    r_pending = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    assert s_pending == sender_init
    assert r_pending == receiver_init

    # Test invalid OTP
    wrong_res = client.post("/gateway/confirm", json={"payment_id": payment_id, "otp": "000000"})
    assert wrong_res.status_code == 400
    assert "Invalid verification code" in wrong_res.json()["detail"]

    # Test valid OTP
    valid_res = client.post("/gateway/confirm", json={"payment_id": payment_id, "otp": pay_data["demo_otp"]})
    assert valid_res.status_code == 200
    confirm_data = valid_res.json()
    assert confirm_data["status"] == "SUCCESS"

    # Now balances must be moved
    s_final = client.get("/gateway/accounts/ACC_0405").json()["balance"]
    r_final = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    assert s_final == round(sender_init - transfer_amount, 2)
    assert r_final == round(receiver_init + transfer_amount, 2)


def test_review_payment_declined_after_three_failed_otps():
    """Verify payment transitions to DECLINED after 3 wrong OTP attempts."""
    res = client.post("/gateway/pay", json={
        "from_account": "ACC_0408",
        "to_account": "ACC_0010",
        "amount": 4950.0,
    })
    payment_id = res.json()["payment_id"]

    # 1st wrong attempt
    r1 = client.post("/gateway/confirm", json={"payment_id": payment_id, "otp": "111111"})
    assert r1.status_code == 400

    # 2nd wrong attempt
    r2 = client.post("/gateway/confirm", json={"payment_id": payment_id, "otp": "222222"})
    assert r2.status_code == 400

    # 3rd wrong attempt -> returns status DECLINED
    r3 = client.post("/gateway/confirm", json={"payment_id": payment_id, "otp": "333333"})
    assert r3.status_code == 200
    assert r3.json()["status"] == "DECLINED"


def test_ledger_lists_payments():
    """Verify /gateway/payments returns the list of recorded payments."""
    client.post("/gateway/pay", json={"from_account": "ACC_0001", "to_account": "ACC_0002", "amount": 250.0})
    client.post("/gateway/pay", json={"from_account": "ACC_0003", "to_account": "ACC_0004", "amount": 350.0})

    res = client.get("/gateway/payments?limit=10")
    assert res.status_code == 200
    payments = res.json()
    assert len(payments) >= 2
    assert payments[0]["from_account"] == "ACC_0003"
    assert payments[1]["from_account"] == "ACC_0001"


def test_reset_restores_balances():
    """Verify POST /gateway/reset and POST /reset restore initial balances and clear ledger."""
    init_bal = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    client.post("/gateway/pay", json={"from_account": "ACC_0010", "to_account": "ACC_0020", "amount": 1000.0})
    assert client.get("/gateway/accounts/ACC_0010").json()["balance"] != init_bal

    # Call reset
    client.post("/reset")
    restored_bal = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    assert restored_bal == init_bal

    # Ledger should be empty
    payments = client.get("/gateway/payments").json()
    assert len(payments) == 0
