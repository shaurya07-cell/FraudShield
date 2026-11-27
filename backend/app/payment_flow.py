"""FraudShield Payment State Machine and Flow Engine.

State transitions:
INITIATED -> FRAUD_CHECK -> then:
- ALLOW -> DEBIT_PENDING -> SUCCESS (or FAILED if insufficient funds)
- REVIEW -> OTP_PENDING (demo OTP, labelled as such) -> SUCCESS, or DECLINED after 3 wrong OTPs
- BLOCK -> DECLINED (no money moves, no Razorpay order is created)

Guarantees:
- Thread-safe transitions with a lock per payment.
- Unique UUID reference IDs generated exclusively by the backend.
- Backend timestamps for state updates and receipt generation.
- Reuses existing fraud scoring and account balances without reimplementing scoring.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
import threading
import time
from typing import Any, Dict, List, Optional
import uuid

from app.schemas import Reason, Transaction
from app.scorer import score_transaction


class PaymentState(str, Enum):
    INITIATED = "INITIATED"
    FRAUD_CHECK = "FRAUD_CHECK"
    DEBIT_PENDING = "DEBIT_PENDING"
    SUCCESS = "SUCCESS"
    OTP_PENDING = "OTP_PENDING"
    DECLINED = "DECLINED"
    FAILED = "FAILED"


# Valid state transitions
VALID_TRANSITIONS: Dict[PaymentState, List[PaymentState]] = {
    PaymentState.INITIATED: [PaymentState.FRAUD_CHECK, PaymentState.FAILED],
    PaymentState.FRAUD_CHECK: [
        PaymentState.DEBIT_PENDING,
        PaymentState.OTP_PENDING,
        PaymentState.DECLINED,
        PaymentState.FAILED,
    ],
    PaymentState.DEBIT_PENDING: [PaymentState.SUCCESS, PaymentState.FAILED],
    PaymentState.OTP_PENDING: [PaymentState.SUCCESS, PaymentState.DECLINED, PaymentState.FAILED],
    PaymentState.SUCCESS: [],
    PaymentState.DECLINED: [],
    PaymentState.FAILED: [],
}


@dataclass
class PaymentFlowRecord:
    reference_id: str
    payment_id: str
    from_account: str
    to_account: str
    amount: float
    state: PaymentState = PaymentState.INITIATED
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    decision: Optional[str] = None
    risk_score: int = 0
    reasons: List[Reason] = field(default_factory=list)
    ring_id: Optional[str] = None
    message: str = ""
    demo_otp: Optional[str] = None
    failed_otp_attempts: int = 0
    fraud_check_ms: float = 0.0
    total_ms: float = 0.0
    sender_balance_after: Optional[float] = None
    receiver_balance_after: Optional[float] = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def transition_to(self, new_state: PaymentState, message: Optional[str] = None) -> None:
        """Atomically transition state with validation."""
        with self.lock:
            allowed = VALID_TRANSITIONS.get(self.state, [])
            if new_state not in allowed:
                raise ValueError(
                    f"Illegal state transition from {self.state.value} to {new_state.value} "
                    f"for payment {self.reference_id}."
                )
            self.state = new_state
            self.updated_at = datetime.now(timezone.utc).isoformat()
            if message is not None:
                self.message = message


class PaymentFlowManager:
    """In-memory coordinator for stateful payment flows with per-payment locking."""

    def __init__(self):
        self._lock = threading.Lock()
        self._records: Dict[str, PaymentFlowRecord] = {}  # by reference_id
        self._by_payment_id: Dict[str, PaymentFlowRecord] = {}

    def get_payment(self, ref_or_id: str) -> Optional[PaymentFlowRecord]:
        with self._lock:
            return self._records.get(ref_or_id) or self._by_payment_id.get(ref_or_id)

    def get_all_payments(self, limit: int = 50) -> List[PaymentFlowRecord]:
        with self._lock:
            records = list(self._records.values())
            records.sort(key=lambda r: r.created_at, reverse=True)
            return records[:limit]

    def create_payment(
        self,
        from_account: str,
        to_account: str,
        amount: float,
        payment_id: Optional[str] = None,
    ) -> PaymentFlowRecord:
        ref_id = str(uuid.uuid4())
        pay_id = payment_id or f"PAY_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6].upper()}"
        record = PaymentFlowRecord(
            reference_id=ref_id,
            payment_id=pay_id,
            from_account=from_account,
            to_account=to_account,
            amount=round(amount, 2),
        )
        with self._lock:
            self._records[ref_id] = record
            self._by_payment_id[pay_id] = record
        return record

    def build_receipt(self, record: PaymentFlowRecord, payer_name: str, payee_name: str) -> Dict[str, Any]:
        """Generate structured JSON receipt from payment record."""
        short_ref = record.reference_id.split("-")[0].upper()
        date_str = record.created_at[:10].replace("-", "")
        receipt_no = f"FS-RCP-{date_str}-{short_ref}"

        return {
            "receipt_number": receipt_no,
            "reference_id": record.reference_id,
            "payment_id": record.payment_id,
            "status": record.state.value,
            "timestamp": record.updated_at,
            "payer": {
                "account_id": record.from_account,
                "name": payer_name,
            },
            "payee": {
                "account_id": record.to_account,
                "name": payee_name,
            },
            "amount": record.amount,
            "currency": "INR",
            "payment_mode": "Simulated Gateway",
            "decision": record.decision,
            "risk_score": record.risk_score,
            "reasons": [r.model_dump() for r in record.reasons],
            "fraud_verified": record.decision == "ALLOW" or record.state == PaymentState.SUCCESS,
            "message": record.message,
        }


# Global payment flow engine singleton
PAYMENT_FLOW = PaymentFlowManager()
