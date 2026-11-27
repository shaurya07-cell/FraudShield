"""Razorpay Test Mode Payment Gateway with FraudShield fraud scoring checkpoint.

Provides real payment processing via Razorpay test mode while keeping FraudShield
as the pre-authorization and webhook fraud checkpoint.
Never logs or exposes secret credentials.
"""
from datetime import datetime, timezone
import hashlib
import hmac
import logging
import os
from pathlib import Path
import threading
import time
from typing import Any, Callable, Dict, List, Optional
import uuid

from dotenv import load_dotenv
from fastapi import APIRouter, HTTPException, Header, Query, Request
from pydantic import BaseModel, Field

import razorpay

from app.metrics import METRICS
from app.schemas import Reason, Transaction
from app.scorer import score_transaction

logger = logging.getLogger("fraudshield.razorpay")

# Load environment variables from backend/.env or repo root .env
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    load_dotenv(dotenv_path=_env_path)
else:
    load_dotenv()


def _get_key_id() -> Optional[str]:
    k = os.getenv("RAZORPAY_KEY_ID", "").strip()
    return k if k and k != "rzp_test_placeholder" else None


def _get_key_secret() -> Optional[str]:
    s = os.getenv("RAZORPAY_KEY_SECRET", "").strip()
    return s if s and s != "placeholder_secret" else None


def _get_webhook_secret() -> Optional[str]:
    w = os.getenv("RAZORPAY_WEBHOOK_SECRET", "").strip()
    return w if w and w != "placeholder_webhook_secret" else None


def is_razorpay_configured() -> bool:
    """Return True if both Key ID and Key Secret are present and not placeholders."""
    return bool(_get_key_id() and _get_key_secret())


def get_razorpay_mode() -> str:
    """Return 'live' if key starts with rzp_live_, else 'test'."""
    key = _get_key_id()
    if key and key.startswith("rzp_live_"):
        logger.warning("Razorpay LIVE credentials detected in environment. Live payments will be enabled!")
        return "live"
    return "test"


def get_razorpay_client() -> razorpay.Client:
    """Instantiate Razorpay client or raise 503 if not configured."""
    key_id = _get_key_id()
    key_secret = _get_key_secret()
    if not key_id or not key_secret:
        raise HTTPException(
            status_code=503,
            detail="Razorpay integration is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env",
        )
    return razorpay.Client(auth=(key_id, key_secret))


# --- Pydantic Models ---

class RazorpayConfigResponse(BaseModel):
    enabled: bool
    mode: str


class RazorpayCreateOrderRequest(BaseModel):
    customer_id: str
    payee_id: Optional[str] = "MERCHANT_001"
    amount_inr: float = Field(..., gt=0)
    device_id: Optional[str] = None


class RazorpayCreateOrderResponse(BaseModel):
    status: str  # ORDER_CREATED | BLOCKED
    order_id: Optional[str] = None
    key_id: Optional[str] = None
    amount: Optional[int] = None  # in paise
    decision: str
    risk_score: int
    reasons: List[Reason] = Field(default_factory=list)
    requires_extra_verification: bool = False
    model_scores: Optional[Dict[str, float]] = None
    message: Optional[str] = None


class RazorpayVerifyRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


class RazorpayVerifyResponse(BaseModel):
    status: str  # VERIFIED | TAMPERED
    order_id: str
    payment_id: str
    message: str


class RazorpayPaymentRecord(BaseModel):
    order_id: str
    payment_id: Optional[str] = None
    status: str  # ORDER_CREATED | BLOCKED | VERIFIED | TAMPERED | AUTHORIZED | CAPTURED | FAILED
    decision: Optional[str] = None
    risk_score: int = 0
    reasons: List[Reason] = Field(default_factory=list)
    amount: float
    created_at: str


# --- Thread-Safe In-Memory Ledger ---

class RazorpayLedger:
    def __init__(self):
        self._lock = threading.Lock()
        self._payments: List[RazorpayPaymentRecord] = []
        self._by_order: Dict[str, RazorpayPaymentRecord] = {}
        self._processed_events: set[str] = set()
        self._broadcast_callback: Optional[Callable[[Dict[str, Any]], Any]] = None

    def set_broadcast_callback(self, cb: Callable[[Dict[str, Any]], Any]) -> None:
        self._broadcast_callback = cb

    async def broadcast(self, payload: Dict[str, Any]) -> None:
        if self._broadcast_callback:
            try:
                res = self._broadcast_callback(payload)
                if hasattr(res, "__await__"):
                    await res
            except Exception:
                pass

    def add_record(self, record: RazorpayPaymentRecord) -> None:
        with self._lock:
            self._payments.append(record)
            self._by_order[record.order_id] = record

    def update_record(self, order_id: str, status: str, payment_id: Optional[str] = None) -> Optional[RazorpayPaymentRecord]:
        with self._lock:
            rec = self._by_order.get(order_id)
            if rec:
                rec.status = status
                if payment_id:
                    rec.payment_id = payment_id
                return rec.model_copy()
            return None

    def get_payments(self, limit: int = 50) -> List[RazorpayPaymentRecord]:
        with self._lock:
            return [p.model_copy() for p in reversed(self._payments[-limit:])]

    def is_event_processed(self, event_id: str) -> bool:
        with self._lock:
            return event_id in self._processed_events

    def mark_event_processed(self, event_id: str) -> None:
        with self._lock:
            self._processed_events.add(event_id)

    def reset(self) -> None:
        with self._lock:
            self._payments.clear()
            self._by_order.clear()
            self._processed_events.clear()


RAZORPAY_LEDGER = RazorpayLedger()
router = APIRouter(prefix="/razorpay", tags=["razorpay"])


@router.get("/config", response_model=RazorpayConfigResponse)
def get_config():
    """Return Razorpay integration status and operating mode (test or live)."""
    return RazorpayConfigResponse(
        enabled=is_razorpay_configured(),
        mode=get_razorpay_mode(),
    )


@router.post("/create-order", response_model=RazorpayCreateOrderResponse)
async def create_order(req: RazorpayCreateOrderRequest):
    """Fraud check and create a Razorpay order if allowed or flagged for review."""
    if not is_razorpay_configured():
        raise HTTPException(
            status_code=503,
            detail="Razorpay integration is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env",
        )

    client = get_razorpay_client()
    key_id = _get_key_id()

    # 1. Synthesize Transaction for FraudShield engine
    now_iso = datetime.now(timezone.utc).isoformat()
    txn_id = f"TXN_RZP_{uuid.uuid4().hex[:12]}"
    sender = req.customer_id.strip()
    receiver = (req.payee_id or "MERCHANT_001").strip()
    device = req.device_id or f"DEV_{sender}"
    ip = "192.168.1.1"

    txn = Transaction(
        txn_id=txn_id,
        timestamp=now_iso,
        sender_id=sender,
        receiver_id=receiver,
        amount=req.amount_inr,
        device_id=device,
        ip=ip,
        channel="RAZORPAY",
    )

    # 2. Score transaction BEFORE creating Razorpay order
    scored = score_transaction(txn)
    await RAZORPAY_LEDGER.broadcast(scored.model_dump())

    # 3. Decision handling
    if scored.decision == "BLOCK":
        blocked_record = RazorpayPaymentRecord(
            order_id=f"BLOCKED_{txn_id}",
            payment_id=None,
            status="BLOCKED",
            decision=scored.decision,
            risk_score=scored.risk_score,
            reasons=scored.reasons,
            amount=req.amount_inr,
            created_at=now_iso,
        )
        RAZORPAY_LEDGER.add_record(blocked_record)

        return RazorpayCreateOrderResponse(
            status="BLOCKED",
            order_id=None,
            key_id=None,
            amount=int(round(req.amount_inr * 100)),
            decision=scored.decision,
            risk_score=scored.risk_score,
            reasons=scored.reasons,
            requires_extra_verification=False,
            model_scores=scored.model_scores,
            message="Payment blocked by FraudShield: high fraud risk detected.",
        )

    # 4. ALLOW or REVIEW: Create Razorpay order
    amount_paise = int(round(req.amount_inr * 100))
    order_data = {
        "amount": amount_paise,
        "currency": "INR",
        "receipt": txn_id,
        "notes": {
            "txn_id": txn_id,
            "fraud_decision": scored.decision,
            "risk_score": str(scored.risk_score),
        },
    }

    try:
        order = client.order.create(data=order_data)
    except Exception as exc:
        logger.error(f"Failed to create Razorpay order: {exc}")
        raise HTTPException(status_code=502, detail=f"Failed to create Razorpay order: {str(exc)}")

    order_id = order.get("id")
    order_record = RazorpayPaymentRecord(
        order_id=order_id,
        payment_id=None,
        status="ORDER_CREATED",
        decision=scored.decision,
        risk_score=scored.risk_score,
        reasons=scored.reasons,
        amount=req.amount_inr,
        created_at=now_iso,
    )
    RAZORPAY_LEDGER.add_record(order_record)

    return RazorpayCreateOrderResponse(
        status="ORDER_CREATED",
        order_id=order_id,
        key_id=key_id,
        amount=amount_paise,
        decision=scored.decision,
        risk_score=scored.risk_score,
        reasons=scored.reasons,
        requires_extra_verification=(scored.decision == "REVIEW"),
        model_scores=scored.model_scores,
        message="Order created successfully. Proceed to payment checkout.",
    )


@router.post("/verify", response_model=RazorpayVerifyResponse)
def verify_payment(req: RazorpayVerifyRequest):
    """Verify cryptographic signature of completed Razorpay payment."""
    if not is_razorpay_configured():
        raise HTTPException(
            status_code=503,
            detail="Razorpay integration is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env",
        )

    key_secret = _get_key_secret()
    client = get_razorpay_client()

    # Signature payload format: order_id + "|" + payment_id
    payload_to_verify = {
        "razorpay_order_id": req.razorpay_order_id,
        "razorpay_payment_id": req.razorpay_payment_id,
        "razorpay_signature": req.razorpay_signature,
    }

    try:
        # verify_payment_signature raises razorpay.errors.SignatureVerificationError if mismatch
        client.utility.verify_payment_signature(payload_to_verify)
    except Exception:
        # Fallback direct HMAC check
        msg = f"{req.razorpay_order_id}|{req.razorpay_payment_id}".encode("utf-8")
        expected_sig = hmac.new(key_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_sig, req.razorpay_signature):
            RAZORPAY_LEDGER.update_record(req.razorpay_order_id, status="TAMPERED", payment_id=req.razorpay_payment_id)
            raise HTTPException(
                status_code=400,
                detail="Payment signature verification failed. Potential tampering detected.",
            )

    RAZORPAY_LEDGER.update_record(req.razorpay_order_id, status="VERIFIED", payment_id=req.razorpay_payment_id)

    return RazorpayVerifyResponse(
        status="VERIFIED",
        order_id=req.razorpay_order_id,
        payment_id=req.razorpay_payment_id,
        message="Payment signature verified successfully.",
    )


@router.post("/webhook")
async def handle_webhook(request: Request, x_razorpay_signature: Optional[str] = Header(None, alias="X-Razorpay-Signature")):
    """Process incoming Razorpay webhook events idempotently with signature verification."""
    webhook_secret = _get_webhook_secret()
    if not webhook_secret:
        raise HTTPException(status_code=503, detail="Razorpay webhook secret is not configured in backend/.env")

    if not x_razorpay_signature:
        raise HTTPException(status_code=400, detail="Missing X-Razorpay-Signature header")

    body_bytes = await request.body()
    body_text = body_bytes.decode("utf-8")

    # Cryptographic verification of webhook payload
    client = get_razorpay_client()
    try:
        client.utility.verify_webhook_signature(body_text, x_razorpay_signature, webhook_secret)
    except Exception:
        # Direct HMAC fallback check
        expected_sig = hmac.new(webhook_secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_sig, x_razorpay_signature):
            raise HTTPException(status_code=400, detail="Invalid webhook signature")

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event = payload.get("event", "")
    event_id = payload.get("event_id") or payload.get("id") or f"{event}_{payload.get('created_at', time.time())}"

    # Idempotency check: ignore duplicate events
    if RAZORPAY_LEDGER.is_event_processed(event_id):
        return {"status": "ignored", "reason": "duplicate_event", "event_id": event_id}

    RAZORPAY_LEDGER.mark_event_processed(event_id)

    handled_events = {"payment.authorized", "payment.captured", "payment.failed", "order.paid"}
    if event not in handled_events:
        return {"status": "ignored", "reason": "unhandled_event", "event": event}

    # Extract payment data
    payment_entity = payload.get("payload", {}).get("payment", {}).get("entity", {})
    order_id = payment_entity.get("order_id") or payload.get("payload", {}).get("order", {}).get("entity", {}).get("id", "")
    payment_id = payment_entity.get("id", "")
    method = payment_entity.get("method", "UPI")
    amount_inr = float(payment_entity.get("amount", 0)) / 100.0

    # Privacy: Hash VPA / phone / contact with SHA-256 (truncated to 12 chars). Never store raw PII!
    raw_identifier = payment_entity.get("vpa") or payment_entity.get("contact") or payment_id or "ANON_CUST"
    customer_hash = hashlib.sha256(raw_identifier.encode("utf-8")).hexdigest()[:12]
    customer_id = f"RZP_{customer_hash}"

    now_iso = datetime.now(timezone.utc).isoformat()
    txn = Transaction(
        txn_id=f"TXN_WH_{uuid.uuid4().hex[:10]}",
        timestamp=now_iso,
        sender_id=customer_id,
        receiver_id="MERCHANT_001",
        amount=amount_inr if amount_inr > 0 else 100.0,
        device_id=f"DEV_{customer_hash[:8]}",
        ip="127.0.0.1",
        channel=f"RZP_{method.upper()}",
    )

    scored = score_transaction(txn)
    await RAZORPAY_LEDGER.broadcast(scored.model_dump())

    status_map = {
        "payment.authorized": "AUTHORIZED",
        "payment.captured": "CAPTURED",
        "payment.failed": "FAILED",
        "order.paid": "VERIFIED",
    }
    target_status = status_map.get(event, "PROCESSED")

    if order_id:
        rec = RAZORPAY_LEDGER.update_record(order_id, status=target_status, payment_id=payment_id)
        if not rec:
            new_rec = RazorpayPaymentRecord(
                order_id=order_id,
                payment_id=payment_id,
                status=target_status,
                decision=scored.decision,
                risk_score=scored.risk_score,
                reasons=scored.reasons,
                amount=amount_inr,
                created_at=now_iso,
            )
            RAZORPAY_LEDGER.add_record(new_rec)

    return {"status": "ok", "event": event, "order_id": order_id, "payment_id": payment_id}


@router.get("/payments", response_model=List[RazorpayPaymentRecord])
def get_payments(limit: int = Query(default=50, ge=1, le=100)):
    """Retrieve ledger of recent Razorpay payments."""
    return RAZORPAY_LEDGER.get_payments(limit=limit)
