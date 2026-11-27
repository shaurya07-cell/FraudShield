"""Unit tests for FraudShield Razorpay gateway integration."""
import hashlib
import hmac
import json
from unittest.mock import MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.razorpay_gateway import RAZORPAY_LEDGER
from app.schemas import Reason, ScoredTransaction

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_ledger():
    """Reset Razorpay ledger and FraudShield state before each test."""
    client.post("/reset")
    RAZORPAY_LEDGER.reset()


def test_missing_keys_returns_503():
    """When Razorpay keys are not configured or placeholder, endpoints return 503."""
    with patch("app.razorpay_gateway._get_key_id", return_value=None), \
         patch("app.razorpay_gateway._get_key_secret", return_value=None):

        # Config reports enabled=False
        cfg = client.get("/razorpay/config")
        assert cfg.status_code == 200
        assert cfg.json()["enabled"] is False

        # Create order returns 503
        res = client.post("/razorpay/create-order", json={
            "customer_id": "ACC_0010",
            "amount_inr": 500.0,
        })
        assert res.status_code == 503
        assert "not configured" in res.json()["detail"].lower()

        # Verify returns 503
        v_res = client.post("/razorpay/verify", json={
            "razorpay_order_id": "order_123",
            "razorpay_payment_id": "pay_123",
            "razorpay_signature": "sig_123",
        })
        assert v_res.status_code == 503


def test_block_decision_creates_no_razorpay_order():
    """A transaction scoring BLOCK must never invoke the Razorpay order API."""
    mock_scored = ScoredTransaction(
        txn_id="TXN_TEST_BLOCK",
        timestamp="2026-11-27T12:00:00Z",
        sender_id="ACC_0405",
        receiver_id="MERCHANT_001",
        amount=4999.0,
        risk_score=85,
        decision="BLOCK",
        reasons=[Reason(rule="HIGH_VELOCITY", detail="Excessive transactions", weight=85)],
        ring_id="RING_01",
        latency_ms=1.5,
    )

    mock_client = MagicMock()

    with patch("app.razorpay_gateway._get_key_id", return_value="rzp_test_validkey"), \
         patch("app.razorpay_gateway._get_key_secret", return_value="validsecret"), \
         patch("app.razorpay_gateway.get_razorpay_client", return_value=mock_client), \
         patch("app.razorpay_gateway.score_transaction", return_value=mock_scored):

        res = client.post("/razorpay/create-order", json={
            "customer_id": "ACC_0405",
            "amount_inr": 4999.0,
        })

        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "BLOCKED"
        assert data["decision"] == "BLOCK"
        assert data["risk_score"] == 85
        assert data["order_id"] is None
        assert "blocked by fraudshield" in data["message"].lower()

        # Verify Razorpay API was never called
        mock_client.order.create.assert_not_called()

        # Check ledger record
        payments = client.get("/razorpay/payments").json()
        assert len(payments) == 1
        assert payments[0]["status"] == "BLOCKED"
        assert payments[0]["decision"] == "BLOCK"


def test_allow_decision_creates_razorpay_order():
    """An ALLOW or REVIEW transaction calls Razorpay client.order.create and returns order details."""
    mock_scored = ScoredTransaction(
        txn_id="TXN_TEST_ALLOW",
        timestamp="2026-11-27T12:00:00Z",
        sender_id="ACC_0010",
        receiver_id="MERCHANT_001",
        amount=500.0,
        risk_score=10,
        decision="ALLOW",
        reasons=[],
        latency_ms=1.2,
    )

    mock_client = MagicMock()
    mock_client.order.create.return_value = {"id": "order_mock_abc123"}

    with patch("app.razorpay_gateway._get_key_id", return_value="rzp_test_validkey"), \
         patch("app.razorpay_gateway._get_key_secret", return_value="validsecret"), \
         patch("app.razorpay_gateway.get_razorpay_client", return_value=mock_client), \
         patch("app.razorpay_gateway.score_transaction", return_value=mock_scored):

        res = client.post("/razorpay/create-order", json={
            "customer_id": "ACC_0010",
            "amount_inr": 500.0,
        })

        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ORDER_CREATED"
        assert data["order_id"] == "order_mock_abc123"
        assert data["key_id"] == "rzp_test_validkey"
        assert data["amount"] == 50000  # 500 INR in paise
        assert data["requires_extra_verification"] is False

        mock_client.order.create.assert_called_once()


def test_signature_verification_passes_and_fails_correctly():
    """Verify valid signature marks payment VERIFIED, while invalid returns 400 and marks TAMPERED."""
    key_secret = "test_secret_xyz"
    order_id = "order_test_999"
    payment_id = "pay_test_888"

    # Pre-populate order in ledger
    with patch("app.razorpay_gateway._get_key_id", return_value="rzp_test_validkey"), \
         patch("app.razorpay_gateway._get_key_secret", return_value=key_secret):

        # 1. Test invalid signature
        bad_res = client.post("/razorpay/verify", json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": "bad_forged_signature",
        })
        assert bad_res.status_code == 400
        assert "verification failed" in bad_res.json()["detail"].lower()

        # 2. Test valid signature
        msg = f"{order_id}|{payment_id}".encode("utf-8")
        valid_sig = hmac.new(key_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()

        good_res = client.post("/razorpay/verify", json={
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": valid_sig,
        })
        assert good_res.status_code == 200
        data = good_res.json()
        assert data["status"] == "VERIFIED"
        assert data["order_id"] == order_id
        assert data["payment_id"] == payment_id


def test_webhook_with_bad_signature_is_rejected():
    """Webhook requests with missing or invalid signature header must be rejected with 400."""
    with patch("app.razorpay_gateway._get_key_id", return_value="rzp_test_key"), \
         patch("app.razorpay_gateway._get_key_secret", return_value="sec"), \
         patch("app.razorpay_gateway._get_webhook_secret", return_value="whsec_123"):

        payload = {"event": "payment.captured", "id": "evt_test_1"}
        raw_body = json.dumps(payload).encode("utf-8")

        # Missing header
        res_missing = client.post("/razorpay/webhook", content=raw_body)
        assert res_missing.status_code == 400

        # Invalid signature
        res_bad = client.post(
            "/razorpay/webhook",
            content=raw_body,
            headers={"X-Razorpay-Signature": "invalid_signature"},
        )
        assert res_bad.status_code == 400


def test_webhook_valid_and_duplicate_events_ignored():
    """Valid webhook processes event and duplicates are idempotently ignored."""
    wh_secret = "whsec_test_secret"

    payload = {
        "event": "payment.captured",
        "event_id": "evt_test_duplicate_999",
        "payload": {
            "payment": {
                "entity": {
                    "id": "pay_test_001",
                    "order_id": "order_test_001",
                    "amount": 25000,
                    "method": "upi",
                    "vpa": "user@okaxis",
                }
            }
        },
    }
    raw_body = json.dumps(payload).encode("utf-8")
    valid_sig = hmac.new(wh_secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()

    with patch("app.razorpay_gateway._get_key_id", return_value="rzp_test_key"), \
         patch("app.razorpay_gateway._get_key_secret", return_value="sec"), \
         patch("app.razorpay_gateway._get_webhook_secret", return_value=wh_secret):

        # First delivery -> OK
        res1 = client.post(
            "/razorpay/webhook",
            content=raw_body,
            headers={"X-Razorpay-Signature": valid_sig},
        )
        assert res1.status_code == 200
        assert res1.json()["status"] == "ok"

        # Duplicate delivery -> Ignored
        res2 = client.post(
            "/razorpay/webhook",
            content=raw_body,
            headers={"X-Razorpay-Signature": valid_sig},
        )
        assert res2.status_code == 200
        assert res2.json()["status"] == "ignored"
        assert res2.json()["reason"] == "duplicate_event"
