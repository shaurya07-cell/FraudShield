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


def test_account_holder_name_field():
    """Verify holder_name is present in account responses and matches fictional name."""
    res = client.get("/gateway/accounts/ACC_0010")
    assert res.status_code == 200
    data = res.json()
    assert "holder_name" in data
    assert data["holder_name"] is not None
    assert len(data["holder_name"]) > 0
    assert data["holder_name"] == data["name"]


def test_resolve_found_account():
    """Verify resolve endpoint successfully resolves valid account IDs."""
    acc = client.get("/gateway/accounts/ACC_0015").json()
    res = client.get("/gateway/resolve?handle=ACC_0015")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is True
    assert data["handle"] == "ACC_0015"
    assert data["kind"] == "account"
    assert data["display_name"] == acc["holder_name"]


def test_resolve_unknown_account():
    """Verify resolve endpoint returns found: False, 200 (not 500 or 404) for unknown handles."""
    res = client.get("/gateway/resolve?handle=ACC_9999")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is False
    assert data["handle"] == "ACC_9999"
    assert data["display_name"] is None


def test_resolve_razorpay_vpa():
    """Verify resolve endpoint returns test payee name for success@razorpay."""
    res = client.get("/gateway/resolve?handle=success@razorpay")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is True
    assert data["handle"] == "success@razorpay"
    assert data["kind"] == "vpa"
    assert data["display_name"] == "Razorpay test payee (test mode)"


def test_resolve_vpa_account():
    """Verify resolve endpoint handles VPA format acc_0010@upi."""
    acc = client.get("/gateway/accounts/ACC_0010").json()
    res = client.get("/gateway/resolve?handle=acc_0010@upi")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is True
    assert data["kind"] == "vpa"
    assert data["display_name"] == acc["holder_name"]


def test_resolve_unknown_vpa():
    """Verify resolve endpoint handles unknown VPA handles cleanly."""
    res = client.get("/gateway/resolve?handle=nonexistent.user@upi")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is False
    assert data["display_name"] is None


def test_register_then_resolve_by_upi():
    """Register a UPI ID then resolve it → found:true, verification:simulated_registry."""
    client.post("/gateway/register-handle", json={
        "display_name": "Demo Tester",
        "upi_id": "demouser@okfakebank",
    })
    res = client.get("/gateway/resolve?handle=demouser@okfakebank")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is True
    assert data["kind"] == "vpa"
    assert data["display_name"] == "Demo Tester"
    assert data["verification"] == "simulated_registry"


def test_register_then_resolve_by_phone():
    """Register a phone then resolve as bare number and with +91 prefix."""
    client.post("/gateway/register-handle", json={
        "display_name": "Demo Phone User",
        "phone": "9900001234",
    })
    res = client.get("/gateway/resolve?handle=9900001234")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is True
    assert data["kind"] == "phone"
    assert data["display_name"] == "Demo Phone User"
    assert data["verification"] == "simulated_registry"
    assert data["masked_phone"] == "xxxxxx1234"

    import urllib.parse
    res2 = client.get(f"/gateway/resolve?handle={urllib.parse.quote('+91 9900001234')}")
    assert res2.status_code == 200
    data2 = res2.json()
    assert data2["found"] is True
    assert data2["masked_phone"] == "xxxxxx1234"


def test_resolve_unregistered_phone_returns_not_found():
    """Bare phone not in registry → found:false."""
    client.post("/reset")  # clear any registrations from prior tests
    res = client.get("/gateway/resolve?handle=9900000099")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is False
    assert data["kind"] == "phone"


def test_resolve_valid_format_unregistered_vpa_returns_format_only():
    """Valid VPA format not registered → found:false, verification:format_only."""
    client.post("/reset")
    res = client.get("/gateway/resolve?handle=abc@fakepsp")
    assert res.status_code == 200
    data = res.json()
    assert data["found"] is False
    assert data["verification"] == "format_only"


def test_register_invalid_phone_returns_400():
    """Invalid phone number → 400."""
    res = client.post("/gateway/register-handle", json={
        "display_name": "Bad Phone",
        "phone": "12345",
    })
    assert res.status_code == 400


def test_register_invalid_upi_returns_400():
    """Invalid UPI ID format → 400."""
    res = client.post("/gateway/register-handle", json={
        "display_name": "Bad UPI",
        "upi_id": "notaupiid",
    })
    assert res.status_code == 400


def test_register_no_identifier_returns_400():
    """No upi_id or phone → 400."""
    res = client.post("/gateway/register-handle", json={
        "display_name": "No ID",
    })
    assert res.status_code == 400


def test_reset_clears_registrations():
    """Register handle, then reset → resolve should return found:false."""
    client.post("/gateway/register-handle", json={
        "display_name": "Temp User",
        "upi_id": "tempuser@okfakebank2",
    })
    resolved_before = client.get("/gateway/resolve?handle=tempuser@okfakebank2").json()
    assert resolved_before["found"] is True

    client.post("/reset")
    resolved_after = client.get("/gateway/resolve?handle=tempuser@okfakebank2").json()
    assert resolved_after["found"] is False


def test_masked_phone_in_response():
    """Phone in resolve response is always masked."""
    client.post("/gateway/register-handle", json={
        "display_name": "Masked Test",
        "phone": "9900005678",
    })
    res = client.get("/gateway/resolve?handle=9900005678")
    assert res.status_code == 200
    data = res.json()
    assert data["masked_phone"] == "xxxxxx5678"
    assert "9900005678" not in str(data.get("phone", ""))


def test_payment_to_registered_upi_succeeds():
    """Pay to a registered UPI ID routes to virtual account."""
    client.post("/reset")
    client.post("/gateway/register-handle", json={
        "display_name": "Fake Payee",
        "upi_id": "fakepayee@okfakebank",
    })
    sender_init = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    res = client.post("/gateway/pay", json={
        "from_account": "ACC_0010",
        "to_account": "fakepayee@okfakebank",
        "amount": 750.0,
        "note": "Test payment to registered UPI",
    })
    assert res.status_code == 200
    assert res.json()["status"] == "SUCCESS"
    assert res.json()["sender_balance_after"] == round(sender_init - 750.0, 2)


def test_payment_to_registered_phone_succeeds():
    """Pay to a registered phone number routes to virtual account."""
    client.post("/reset")
    client.post("/gateway/register-handle", json={
        "display_name": "Fake Phone Payee",
        "phone": "9900009999",
    })
    sender_init = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    res = client.post("/gateway/pay", json={
        "from_account": "ACC_0010",
        "to_account": "9900009999",
        "amount": 500.0,
    })
    assert res.status_code == 200
    assert res.json()["status"] == "SUCCESS"
    assert res.json()["sender_balance_after"] == round(sender_init - 500.0, 2)


def test_payment_to_external_vpa_allowed_succeeds():
    """Payment to a format-valid external VPA succeeds on ALLOW with sender balance debited and receiver_balance_after None."""
    client.post("/reset")
    sender_init = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    res = client.post("/gateway/pay", json={
        "from_account": "ACC_0010",
        "to_account": "merchant@upi",
        "amount": 250.0,
        "note": "Payment to external UPI ID",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "SUCCESS"
    assert data["decision"] == "ALLOW"
    assert data["sender_balance_after"] == round(sender_init - 250.0, 2)
    assert data["receiver_balance_after"] is None
    assert data["reference_id"] is not None

    # Verify receipt can be retrieved for external VPA payment
    receipt_res = client.get(f"/gateway/payments/{data['reference_id']}/receipt")
    assert receipt_res.status_code == 200
    rcp = receipt_res.json()
    assert rcp["payee"]["account_id"] == "merchant@upi"


def test_payment_to_external_vpa_blocked_declined():
    """Payment to external VPA from a high-risk flagged sender is DECLINED with balances untouched."""
    client.post("/reset")
    client.post("/simulate/velocity_attack")
    recent = client.get("/transactions/recent").json()
    flagged_sender = recent[0]["sender_id"]

    sender_init = client.get(f"/gateway/accounts/{flagged_sender}").json()["balance"]
    res = client.post("/gateway/pay", json={
        "from_account": flagged_sender,
        "to_account": "externalpayee@upi",
        "amount": 4900.0,
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "DECLINED"
    assert data["decision"] == "BLOCK"
    assert data["sender_balance_after"] == sender_init

    sender_after = client.get(f"/gateway/accounts/{flagged_sender}").json()["balance"]
    assert sender_after == sender_init


def test_payment_to_external_vpa_review_requires_otp_and_settles():
    """Payment to external VPA in REVIEW requires OTP, and confirming OTP debits sender with receiver_balance_after None."""
    client.post("/reset")
    sender_init = client.get("/gateway/accounts/ACC_0405").json()["balance"]
    transfer_amount = 4950.0

    res = client.post("/gateway/pay", json={
        "from_account": "ACC_0405",
        "to_account": "suspicious@upi",
        "amount": transfer_amount,
    })
    assert res.status_code == 200
    pay_data = res.json()
    assert pay_data["decision"] == "REVIEW"
    assert pay_data["status"] == "PENDING_VERIFICATION"
    assert pay_data["demo_otp"] is not None
    assert len(pay_data["demo_otp"]) == 6

    # Sender balance unchanged while pending
    s_pending = client.get("/gateway/accounts/ACC_0405").json()["balance"]
    assert s_pending == sender_init

    # Confirm OTP
    confirm_res = client.post("/gateway/confirm", json={
        "payment_id": pay_data["payment_id"],
        "otp": pay_data["demo_otp"],
    })
    assert confirm_res.status_code == 200
    confirm_data = confirm_res.json()
    assert confirm_data["status"] == "SUCCESS"
    assert confirm_data["sender_balance_after"] == round(sender_init - transfer_amount, 2)
    assert confirm_data["receiver_balance_after"] is None

    # Check updated balance in accounts
    s_after = client.get("/gateway/accounts/ACC_0405").json()["balance"]
    assert s_after == round(sender_init - transfer_amount, 2)


def test_payment_to_malformed_vpa_rejected():
    """Payment to a malformed VPA is immediately rejected with status FAILED without running fraud check."""
    client.post("/reset")
    sender_init = client.get("/gateway/accounts/ACC_0010").json()["balance"]

    for bad_vpa in ["notanemail", "bad@@upi", "a@b", "user@"]:
        res = client.post("/gateway/pay", json={
            "from_account": "ACC_0010",
            "to_account": bad_vpa,
            "amount": 100.0,
        })
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "FAILED"
        assert data["decision"] is None
        assert data["fraud_check_ms"] == 0.0
        assert "does not exist" in data["message"]

    sender_after = client.get("/gateway/accounts/ACC_0010").json()["balance"]
    assert sender_after == sender_init


def test_parse_upi_qr_with_pn():
    """Verify POST /gateway/parse-upi-qr extracts pa, pn, and am safely, ignoring unknown parameters."""
    qr_payload = "upi://pay?pa=store@upi&pn=Retail%20Store&am=250.00&mc=5411&tr=TX123456"
    res = client.post("/gateway/parse-upi-qr", json={"qr_content": qr_payload})
    assert res.status_code == 200
    data = res.json()
    assert data["valid"] is True
    assert data["pa"] == "store@upi"
    assert data["pn"] == "Retail Store"
    assert data["am"] == "250.00"


def test_parse_upi_qr_without_pn():
    """Verify POST /gateway/parse-upi-qr parses QR with pa and am without pn."""
    qr_payload = "upi://pay?pa=seller@bank&am=100.00"
    res = client.post("/gateway/parse-upi-qr", json={"qr_content": qr_payload})
    assert res.status_code == 200
    data = res.json()
    assert data["valid"] is True
    assert data["pa"] == "seller@bank"
    assert data["pn"] is None
    assert data["am"] == "100.00"


def test_parse_upi_qr_malformed():
    """Verify POST /gateway/parse-upi-qr returns valid=False for malformed QRs and invalid VPAs."""
    bad_payloads = [
        "https://example.com/pay",
        "upi://notpay?pa=store@upi",
        "upi://pay?pn=StoreOnly",
        "upi://pay?pa=not_a_vpa",
        "not a url at all",
        "",
    ]
    for bad in bad_payloads:
        res = client.post("/gateway/parse-upi-qr", json={"qr_content": bad})
        assert res.status_code == 200
        data = res.json()
        assert data["valid"] is False

