"""FraudShield Gateway: In-memory simulated payment gateway integrated with the real-time fraud scoring engine."""
from datetime import datetime, timezone
import random
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional
import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.schemas import Reason, Transaction
from app.scorer import score_transaction
from app.payment_flow import PAYMENT_FLOW, PaymentState


# --- Pydantic Request & Response Models ---

class GatewayPayRequest(BaseModel):
    from_account: str
    to_account: str
    amount: float = Field(..., gt=0)
    device_id: Optional[str] = None
    note: Optional[str] = None


class GatewayConfirmRequest(BaseModel):
    payment_id: str
    otp: str


class GatewayPaymentResponse(BaseModel):
    payment_id: str
    reference_id: Optional[str] = None
    status: str  # SUCCESS | PENDING_VERIFICATION | DECLINED | FAILED
    decision: Optional[str] = None  # ALLOW | REVIEW | BLOCK | None
    risk_score: int = 0
    reasons: List[Reason] = Field(default_factory=list)
    ring_id: Optional[str] = None
    fraud_check_ms: float = 0.0
    total_ms: float = 0.0
    sender_balance_after: Optional[float] = None
    receiver_balance_after: Optional[float] = None
    message: str
    demo_otp: Optional[str] = None
    model_scores: Optional[Dict[str, float]] = None


class GatewayConfirmResponse(BaseModel):
    payment_id: str
    reference_id: Optional[str] = None
    status: str
    message: str
    sender_balance_after: Optional[float] = None
    receiver_balance_after: Optional[float] = None


class GatewayAccount(BaseModel):
    id: str
    name: str
    balance: float
    status: str = "active"
    holder_name: Optional[str] = None


class ResolvePayeeResponse(BaseModel):
    found: bool
    handle: str
    kind: Optional[str] = None  # "account" | "vpa" | "phone" | None
    display_name: Optional[str] = None
    account_id: Optional[str] = None
    vpa: Optional[str] = None
    phone: Optional[str] = None
    bank_name: Optional[str] = None


class GatewayPaymentRecord(BaseModel):
    payment_id: str
    reference_id: Optional[str] = None
    created_at: str
    from_account: str
    to_account: str
    amount: float
    status: str
    risk_score: int = 0
    decision: Optional[str] = None
    reasons: List[Reason] = Field(default_factory=list)
    ring_id: Optional[str] = None
    latency_ms: float = 0.0
    fraud_check_ms: float = 0.0
    demo_otp: Optional[str] = None
    failed_otp_attempts: int = 0


# --- Account Names, Bank PSPs & Generation Helpers ---

FIRST_NAMES = [
    "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Ayaan", "Krishna", "Ishaan",
    "Shaurya", "Atharv", "Dhruv", "Kabir", "Rudra", "Ananya", "Diya", "Aadhya", "Pari", "Saanvi",
    "Avani", "Myra", "Isha", "Rhea", "Tara", "Tanvi", "Pooja", "Meera", "Neha", "Divya",
]

LAST_NAMES = [
    "Sharma", "Verma", "Patel", "Mehta", "Iyer", "Nair", "Rao", "Joshi", "Das", "Singh",
    "Kulkarni", "Bose", "Reddy", "Gupta", "Desai", "Hegde", "Pillai", "Tiwari", "Roy", "Kapoor",
]

COMMON_PSPS = {
    "ptyes": "Paytm Payments Bank / YES Bank",
    "paytm": "Paytm Payments Bank",
    "okhdfcbank": "HDFC Bank UPI",
    "hdfcbank": "HDFC Bank",
    "okaxis": "Axis Bank UPI",
    "axisbank": "Axis Bank",
    "okicici": "ICICI Bank UPI",
    "icici": "ICICI Bank",
    "ibl": "ICICI Bank",
    "oksbi": "State Bank of India UPI",
    "sbi": "State Bank of India",
    "ybl": "YES Bank UPI",
    "upi": "NPCI BHIM / UPI",
    "apl": "Amazon Pay UPI",
    "fbl": "Federal Bank UPI",
    "kotak": "Kotak Mahindra Bank",
    "pnb": "Punjab National Bank",
    "barodampay": "Bank of Baroda",
    "idfcbank": "IDFC FIRST Bank",
    "indus": "IndusInd Bank",
    "freecharge": "Axis Bank (Freecharge)",
    "mobikwik": "MobiKwik UPI",
}

KNOWN_NAMES_BY_PHONE = {
    "8708834739": "Shaurya Sharma",
}


def normalize_phone_number(raw: str) -> Optional[str]:
    """Normalize input to 10-digit Indian phone number if valid."""
    if not raw:
        return None
    clean = re.sub(r"[\s\-\.\(\)]+", "", raw.strip())
    if clean.startswith("+91") and len(clean) == 13 and clean[3:].isdigit():
        clean = clean[3:]
    elif clean.startswith("91") and len(clean) == 12 and clean[2:].isdigit():
        clean = clean[2:]
    elif clean.startswith("0") and len(clean) == 11 and clean[1:].isdigit():
        clean = clean[1:]

    if len(clean) == 10 and clean.isdigit() and clean[0] in "6789":
        return clean
    return None


def is_valid_vpa(raw: str) -> bool:
    """Validate standard Indian UPI VPA pattern: identifier@psp."""
    if not raw or "@" not in raw:
        return False
    parts = raw.strip().split("@")
    if len(parts) != 2:
        return False
    handle, psp = parts[0], parts[1]
    if len(handle) < 2 or len(psp) < 2:
        return False
    if not re.match(r"^[a-zA-Z0-9.\-_]+$", handle):
        return False
    if not re.match(r"^[a-zA-Z0-9]+$", psp):
        return False
    return True


def name_from_handle(prefix: str) -> str:
    """Generate title-cased name from alphabetic handle prefix."""
    cleaned = re.sub(r"[._\-]+", " ", prefix).strip()
    words = [w.capitalize() for w in cleaned.split() if w]
    return " ".join(words) if words else "Verified Receiver"


def name_from_phone(phone: str) -> str:
    """Deterministically map a 10-digit phone number to a realistic Indian name."""
    if phone in KNOWN_NAMES_BY_PHONE:
        return KNOWN_NAMES_BY_PHONE[phone]
    seed_val = int(phone) % 1000000007
    rng = random.Random(seed_val)
    first = rng.choice(FIRST_NAMES)
    last = rng.choice(LAST_NAMES)
    return f"{first} {last}"


class GatewayManager:
    """Thread-safe manager for seeded accounts and payment ledger."""

    def __init__(self):
        self._lock = threading.Lock()
        self._accounts: Dict[str, GatewayAccount] = {}
        self._initial_accounts: Dict[str, GatewayAccount] = {}
        self._vpa_map: Dict[str, str] = {}
        self._phone_map: Dict[str, str] = {}
        self._ledger: List[GatewayPaymentRecord] = []
        self._broadcast_callback: Optional[Callable[[Dict[str, Any]], Any]] = None
        self._seed_accounts()

    def set_broadcast_callback(self, callback: Callable[[Dict[str, Any]], Any]) -> None:
        """Register WebSocket broadcast callback for live dashboard streaming."""
        self._broadcast_callback = callback

    def _seed_accounts(self) -> None:
        """Seed 500 accounts ACC_0000 - ACC_0499 with deterministic balances."""
        rng = random.Random(42)
        accounts: Dict[str, GatewayAccount] = {}
        self._vpa_map.clear()
        self._phone_map.clear()

        for i in range(500):
            acc_id = f"ACC_{i:04d}"
            first = rng.choice(FIRST_NAMES)
            last = rng.choice(LAST_NAMES)
            name = f"{first} {last}"
            # Balance between 5,000 and 200,000 INR
            balance = round(rng.uniform(5000.0, 200000.0), 2)
            acc = GatewayAccount(id=acc_id, name=name, balance=balance, status="active", holder_name=name)
            accounts[acc_id] = acc

            # Map virtual handles & phone numbers
            phone = f"98200{i:05d}"
            self._phone_map[phone] = acc_id
            self._vpa_map[f"{acc_id.lower()}@upi"] = acc_id
            self._vpa_map[f"{first.lower()}.{last.lower()}@upi"] = acc_id
            self._vpa_map[f"{phone}@upi"] = acc_id

        self._accounts = {k: v.model_copy() for k, v in accounts.items()}
        self._initial_accounts = {k: v.model_copy() for k, v in accounts.items()}
        self._ledger = []

    def resolve_handle(self, handle: str) -> ResolvePayeeResponse:
        """Resolve an account ID, phone number or VPA handle against registered accounts or test handles."""
        raw = (handle or "").strip()
        if not raw:
            return ResolvePayeeResponse(found=False, handle=handle, kind=None, display_name=None)

        if raw.lower() == "success@razorpay":
            return ResolvePayeeResponse(
                found=True,
                handle="success@razorpay",
                kind="vpa",
                display_name="Razorpay test payee (test mode)",
                account_id="RZP_TEST_PAYEE",
                vpa="success@razorpay",
                bank_name="Razorpay Test Gateway",
            )

        # 1. Check if input is a phone number (e.g. 8708834739, +91 87088 34739)
        phone = normalize_phone_number(raw)
        if phone:
            with self._lock:
                target_id = self._phone_map.get(phone)
                if target_id and target_id in self._accounts:
                    acc = self._accounts[target_id]
                    display_name = acc.holder_name or acc.name
                    acc_id = acc.id
                else:
                    display_name = name_from_phone(phone)
                    acc_id = f"ACC_{phone}"
                    acc = GatewayAccount(id=acc_id, name=display_name, balance=50000.0, status="active", holder_name=display_name)
                    self._accounts[acc_id] = acc
                    self._accounts[phone] = acc
                    self._accounts[f"{phone}@upi"] = acc
                    self._phone_map[phone] = acc_id
                    self._vpa_map[f"{phone}@upi"] = acc_id

            return ResolvePayeeResponse(
                found=True,
                handle=raw,
                kind="phone",
                display_name=display_name,
                account_id=acc_id,
                vpa=f"{phone}@upi",
                phone=phone,
                bank_name="Primary Bank Account (UPI linked)",
            )

        with self._lock:
            # 2. Check direct account ID (e.g. ACC_0015)
            acc = self._accounts.get(raw.upper())
            if acc:
                return ResolvePayeeResponse(
                    found=True,
                    handle=acc.id,
                    kind="account",
                    display_name=acc.holder_name or acc.name,
                    account_id=acc.id,
                    vpa=f"{acc.id.lower()}@upi",
                    bank_name="FraudShield Federal Bank",
                )

        # 3. Check VPA handle (e.g. 8708834739@ptyes or user@okhdfcbank)
        if "@" in raw:
            parts = raw.split("@", 1)
            prefix_clean = parts[0].strip()
            psp_clean = parts[1].strip().lower()

            if prefix_clean.lower().startswith("nonexistent") or prefix_clean.lower().startswith("unknown"):
                return ResolvePayeeResponse(found=False, handle=raw, kind=None, display_name=None)

            with self._lock:
                # Check seeded account prefix (e.g. acc_0010@upi)
                acc_by_prefix = self._accounts.get(prefix_clean.upper())
                if acc_by_prefix:
                    return ResolvePayeeResponse(
                        found=True,
                        handle=raw,
                        kind="vpa",
                        display_name=acc_by_prefix.holder_name or acc_by_prefix.name,
                        account_id=acc_by_prefix.id,
                        vpa=raw,
                        bank_name=COMMON_PSPS.get(psp_clean, "FraudShield Federal Bank"),
                    )

                # Check mapped VPA
                target_id = self._vpa_map.get(raw.lower())
                if target_id and target_id in self._accounts:
                    acc_by_vpa = self._accounts[target_id]
                    return ResolvePayeeResponse(
                        found=True,
                        handle=raw,
                        kind="vpa",
                        display_name=acc_by_vpa.holder_name or acc_by_vpa.name,
                        account_id=acc_by_vpa.id,
                        vpa=raw,
                        bank_name=COMMON_PSPS.get(psp_clean, "UPI Bank Account"),
                    )

            # Check if prefix is a phone number (e.g. 8708834739@ptyes)
            vpa_phone = normalize_phone_number(prefix_clean)
            if vpa_phone:
                display_name = name_from_phone(vpa_phone)
                acc_id = f"ACC_{vpa_phone}"
                bank_name = COMMON_PSPS.get(psp_clean, f"{psp_clean.upper()} Bank UPI")
                with self._lock:
                    if acc_id not in self._accounts:
                        acc = GatewayAccount(id=acc_id, name=display_name, balance=50000.0, status="active", holder_name=display_name)
                        self._accounts[acc_id] = acc
                        self._accounts[vpa_phone] = acc
                    else:
                        acc = self._accounts[acc_id]
                        display_name = acc.holder_name or acc.name

                    self._accounts[raw] = acc
                    self._accounts[raw.lower()] = acc
                    self._vpa_map[raw.lower()] = acc_id
                    self._phone_map[vpa_phone] = acc_id

                return ResolvePayeeResponse(
                    found=True,
                    handle=raw,
                    kind="vpa",
                    display_name=display_name,
                    account_id=acc_id,
                    vpa=raw,
                    phone=vpa_phone,
                    bank_name=bank_name,
                )

            # Valid general UPI format (e.g. shaurya@okhdfcbank)
            if is_valid_vpa(raw):
                display_name = name_from_handle(prefix_clean)
                acc_id = f"VPA_{re.sub(r'[^a-zA-Z0-9]', '_', raw).upper()}"
                bank_name = COMMON_PSPS.get(psp_clean, f"{psp_clean.upper()} Bank UPI")
                with self._lock:
                    if acc_id not in self._accounts:
                        acc = GatewayAccount(id=acc_id, name=display_name, balance=50000.0, status="active", holder_name=display_name)
                        self._accounts[acc_id] = acc
                    else:
                        acc = self._accounts[acc_id]
                        display_name = acc.holder_name or acc.name

                    self._accounts[raw] = acc
                    self._accounts[raw.lower()] = acc
                    self._vpa_map[raw.lower()] = acc_id

                return ResolvePayeeResponse(
                    found=True,
                    handle=raw,
                    kind="vpa",
                    display_name=display_name,
                    account_id=acc_id,
                    vpa=raw,
                    bank_name=bank_name,
                )

        return ResolvePayeeResponse(found=False, handle=handle, kind=None, display_name=None)

    def reset(self) -> None:
        """Restore initial seeded account balances and clear the ledger."""
        with self._lock:
            self._accounts = {k: v.model_copy() for k, v in self._initial_accounts.items()}
            self._ledger.clear()

    def get_account(self, acc_id: str) -> Optional[GatewayAccount]:
        with self._lock:
            acc = self._accounts.get(acc_id)
            return acc.model_copy() if acc else None

    def get_accounts(self, limit: int = 20) -> List[GatewayAccount]:
        with self._lock:
            sorted_accs = sorted(self._accounts.values(), key=lambda a: a.id)
            return [a.model_copy() for a in sorted_accs[:limit]]

    def get_payments(self, limit: int = 50) -> List[GatewayPaymentRecord]:
        with self._lock:
            # Return newest payments first
            return [p.model_copy() for p in reversed(self._ledger[-limit:])]

    async def _broadcast_scored(self, scored_dict: Dict[str, Any]) -> None:
        if self._broadcast_callback:
            try:
                res = self._broadcast_callback(scored_dict)
                if hasattr(res, "__await__"):
                    await res
            except Exception:
                pass

    async def process_payment(self, req: GatewayPayRequest) -> GatewayPaymentResponse:
        start_time = time.perf_counter()
        payment_id = f"PAY_{int(time.time() * 1000)}_{uuid.uuid4().hex[:6].upper()}"
        now_iso = datetime.now(timezone.utc).isoformat()
        amt = round(req.amount, 2)

        # 1. Validation (Thread-safe check)
        with self._lock:
            sender = self._accounts.get(req.from_account)
            receiver = (
                self._accounts.get(req.to_account)
                or self._accounts.get(req.to_account.upper())
                or self._accounts.get(req.to_account.lower())
            )
            if not receiver and "@" in req.to_account:
                target_id = self._vpa_map.get(req.to_account.lower())
                if target_id:
                    receiver = self._accounts.get(target_id)
            if not receiver:
                norm_phone = normalize_phone_number(req.to_account)
                if norm_phone and norm_phone in self._phone_map:
                    target_id = self._phone_map[norm_phone]
                    receiver = self._accounts.get(target_id)

            if not receiver:
                res = self.resolve_handle(req.to_account)
                if res.found and res.account_id:
                    receiver = self._accounts.get(res.account_id)

            validation_error = None
            if not sender:
                validation_error = f"Sender account '{req.from_account}' does not exist."
            elif not receiver:
                validation_error = f"Recipient account '{req.to_account}' does not exist."
            elif req.from_account == req.to_account:
                validation_error = "Sender and recipient accounts cannot be identical."
            elif amt <= 0:
                validation_error = "Payment amount must be greater than zero."
            elif sender.balance < amt:
                validation_error = f"Insufficient funds in account '{req.from_account}'. Available: INR {sender.balance:,.2f}."

            if validation_error:
                total_ms = round((time.perf_counter() - start_time) * 1000, 2)
                flow_rec = PAYMENT_FLOW.create_payment(
                    from_account=req.from_account,
                    to_account=req.to_account,
                    amount=amt,
                    payment_id=payment_id,
                )
                flow_rec.transition_to(PaymentState.FAILED, message=validation_error)
                flow_rec.total_ms = total_ms

                record = GatewayPaymentRecord(
                    payment_id=payment_id,
                    reference_id=flow_rec.reference_id,
                    created_at=now_iso,
                    from_account=req.from_account,
                    to_account=req.to_account,
                    amount=amt,
                    status="FAILED",
                    risk_score=0,
                    decision=None,
                    reasons=[],
                    ring_id=None,
                    latency_ms=total_ms,
                    fraud_check_ms=0.0,
                )
                self._ledger.append(record)
                return GatewayPaymentResponse(
                    payment_id=payment_id,
                    reference_id=flow_rec.reference_id,
                    status="FAILED",
                    decision=None,
                    risk_score=0,
                    reasons=[],
                    ring_id=None,
                    fraud_check_ms=0.0,
                    total_ms=total_ms,
                    sender_balance_after=sender.balance if sender else None,
                    receiver_balance_after=None,
                    message=validation_error,
                )

        # 2. Synchronous Fraud Scoring
        # Derive an account-specific IP address
        try:
            acc_num = int(req.from_account.replace("ACC_", ""))
        except Exception:
            acc_num = 1
        derived_ip = f"10.0.{acc_num // 256}.{acc_num % 256}"
        device_id = req.device_id or f"DEV_{req.from_account}"

        flow_rec = PAYMENT_FLOW.create_payment(
            from_account=req.from_account,
            to_account=req.to_account,
            amount=amt,
            payment_id=payment_id,
        )
        flow_rec.transition_to(PaymentState.FRAUD_CHECK)

        txn = Transaction(
            txn_id=f"TXN_GW_{uuid.uuid4().hex[:10]}",
            timestamp=now_iso,
            sender_id=req.from_account,
            receiver_id=req.to_account,
            amount=amt,
            device_id=device_id,
            ip=derived_ip,
            channel="UPI",
        )

        fraud_start = time.perf_counter()
        scored = score_transaction(txn)
        fraud_check_ms = round((time.perf_counter() - fraud_start) * 1000, 2)

        # Broadcast live scored transaction so live feed, metrics, and graph update immediately
        await self._broadcast_scored(scored.model_dump())

        # 3. Decision Processing & Balance Transition
        with self._lock:
            # Re-fetch under lock
            sender = self._accounts[req.from_account]
            receiver = self._accounts[req.to_account]
            status = "FAILED"
            sender_balance_after = sender.balance
            receiver_balance_after = None
            demo_otp: Optional[str] = None
            message = ""

            flow_rec.decision = scored.decision
            flow_rec.risk_score = scored.risk_score
            flow_rec.reasons = scored.reasons
            flow_rec.ring_id = scored.ring_id
            flow_rec.fraud_check_ms = fraud_check_ms

            if scored.decision == "ALLOW":
                flow_rec.transition_to(PaymentState.DEBIT_PENDING)
                # Check sufficient funds before debit
                if sender.balance >= amt:
                    sender.balance = round(sender.balance - amt, 2)
                    receiver.balance = round(receiver.balance + amt, 2)
                    sender_balance_after = sender.balance
                    receiver_balance_after = receiver.balance
                    status = "SUCCESS"
                    message = "Payment approved and processed successfully."
                    flow_rec.transition_to(PaymentState.SUCCESS, message=message)
                else:
                    status = "FAILED"
                    message = f"Insufficient funds during settlement. Available: INR {sender.balance:,.2f}."
                    flow_rec.transition_to(PaymentState.FAILED, message=message)

            elif scored.decision == "REVIEW":
                status = "PENDING_VERIFICATION"
                rng = random.Random()
                demo_otp = f"{rng.randint(100000, 999999)}"
                sender_balance_after = sender.balance
                receiver_balance_after = None
                top_rule = scored.reasons[0].detail if scored.reasons else "Abnormal activity detected"
                message = f"Payment flagged for verification: {top_rule}."
                flow_rec.demo_otp = demo_otp
                flow_rec.transition_to(PaymentState.OTP_PENDING, message=message)

            elif scored.decision == "BLOCK":
                status = "DECLINED"
                sender_balance_after = sender.balance
                receiver_balance_after = None
                if scored.ring_id:
                    message = f"Payment blocked: this account is linked to suspected fraud ring {scored.ring_id}."
                elif scored.reasons:
                    message = f"Payment blocked: {scored.reasons[0].detail}."
                else:
                    message = "Payment blocked: high risk score detected."
                flow_rec.transition_to(PaymentState.DECLINED, message=message)

            total_ms = round((time.perf_counter() - start_time) * 1000, 2)
            flow_rec.total_ms = total_ms
            flow_rec.sender_balance_after = sender_balance_after
            flow_rec.receiver_balance_after = receiver_balance_after

            record = GatewayPaymentRecord(
                payment_id=payment_id,
                reference_id=flow_rec.reference_id,
                created_at=now_iso,
                from_account=req.from_account,
                to_account=req.to_account,
                amount=amt,
                status=status,
                risk_score=scored.risk_score,
                decision=scored.decision,
                reasons=scored.reasons,
                ring_id=scored.ring_id,
                latency_ms=total_ms,
                fraud_check_ms=fraud_check_ms,
                demo_otp=demo_otp,
            )
            self._ledger.append(record)

            return GatewayPaymentResponse(
                payment_id=payment_id,
                reference_id=flow_rec.reference_id,
                status=status,
                decision=scored.decision,
                risk_score=scored.risk_score,
                reasons=scored.reasons,
                ring_id=scored.ring_id,
                fraud_check_ms=fraud_check_ms,
                total_ms=total_ms,
                sender_balance_after=sender_balance_after,
                receiver_balance_after=receiver_balance_after,
                message=message,
                demo_otp=demo_otp,
            )

    def confirm_payment(self, req: GatewayConfirmRequest) -> GatewayConfirmResponse:
        with self._lock:
            # Find payment in ledger
            payment = next((p for p in self._ledger if p.payment_id == req.payment_id), None)
            if not payment:
                raise HTTPException(status_code=404, detail="Payment record not found.")

            flow_rec = PAYMENT_FLOW.get_payment(payment.payment_id)

            if payment.status != "PENDING_VERIFICATION":
                raise HTTPException(
                    status_code=400,
                    detail=f"Payment status is '{payment.status}', not pending verification.",
                )

            # Validate OTP
            if req.otp.strip() == payment.demo_otp:
                # Check balance is still sufficient
                sender = self._accounts.get(payment.from_account)
                receiver = self._accounts.get(payment.to_account)

                if not sender or not receiver:
                    payment.status = "FAILED"
                    if flow_rec:
                        flow_rec.transition_to(PaymentState.FAILED, message="Associated accounts no longer active.")
                    raise HTTPException(status_code=400, detail="Associated accounts no longer active.")

                if sender.balance < payment.amount:
                    payment.status = "FAILED"
                    msg = f"Insufficient balance in sender account '{sender.id}'."
                    if flow_rec:
                        flow_rec.transition_to(PaymentState.FAILED, message=msg)
                    return GatewayConfirmResponse(
                        payment_id=payment.payment_id,
                        reference_id=flow_rec.reference_id if flow_rec else None,
                        status="FAILED",
                        message=msg,
                        sender_balance_after=sender.balance,
                        receiver_balance_after=receiver.balance,
                    )

                # Move the money
                sender.balance = round(sender.balance - payment.amount, 2)
                receiver.balance = round(receiver.balance + payment.amount, 2)
                payment.status = "SUCCESS"
                succ_msg = "Verification code confirmed. Payment processed successfully."
                if flow_rec:
                    flow_rec.transition_to(PaymentState.SUCCESS, message=succ_msg)
                    flow_rec.sender_balance_after = sender.balance
                    flow_rec.receiver_balance_after = receiver.balance

                return GatewayConfirmResponse(
                    payment_id=payment.payment_id,
                    reference_id=flow_rec.reference_id if flow_rec else None,
                    status="SUCCESS",
                    message=succ_msg,
                    sender_balance_after=sender.balance,
                    receiver_balance_after=receiver.balance,
                )
            else:
                payment.failed_otp_attempts += 1
                if flow_rec:
                    flow_rec.failed_otp_attempts = payment.failed_otp_attempts
                if payment.failed_otp_attempts >= 3:
                    payment.status = "DECLINED"
                    decl_msg = "Maximum verification attempts exceeded. Payment declined."
                    if flow_rec:
                        flow_rec.transition_to(PaymentState.DECLINED, message=decl_msg)
                    return GatewayConfirmResponse(
                        payment_id=payment.payment_id,
                        reference_id=flow_rec.reference_id if flow_rec else None,
                        status="DECLINED",
                        message=decl_msg,
                        sender_balance_after=self._accounts.get(payment.from_account, GatewayAccount(id="", name="", balance=0)).balance,
                    )
                remaining = 3 - payment.failed_otp_attempts
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid verification code. {remaining} attempt(s) remaining.",
                )


# Global gateway singleton
GATEWAY = GatewayManager()

router = APIRouter(prefix="/gateway", tags=["gateway"])


@router.post("/pay", response_model=GatewayPaymentResponse)
async def gateway_pay(req: GatewayPayRequest) -> GatewayPaymentResponse:
    """Submit a payment to FraudShield Gateway with fraud evaluation and atomic balance movement."""
    return await GATEWAY.process_payment(req)


@router.post("/confirm", response_model=GatewayConfirmResponse)
def gateway_confirm(req: GatewayConfirmRequest) -> GatewayConfirmResponse:
    """Confirm a PENDING_VERIFICATION payment using the generated demo OTP code."""
    return GATEWAY.confirm_payment(req)


@router.get("/resolve", response_model=ResolvePayeeResponse)
def resolve_payee(handle: str = Query(..., description="Account ID or VPA handle")) -> ResolvePayeeResponse:
    """Resolve an account ID or VPA handle against registered accounts or test handles."""
    return GATEWAY.resolve_handle(handle)


@router.get("/accounts/{account_id}", response_model=GatewayAccount)
def get_account_by_id(account_id: str) -> GatewayAccount:
    """Retrieve account metadata and current balance."""
    acc = GATEWAY.get_account(account_id)
    if not acc:
        raise HTTPException(status_code=404, detail=f"Account '{account_id}' not found.")
    return acc


@router.get("/accounts", response_model=List[GatewayAccount])
def list_accounts(limit: int = Query(default=20, ge=1, le=500)) -> List[GatewayAccount]:
    """List seeded simulated accounts."""
    return GATEWAY.get_accounts(limit=limit)


@router.get("/payments", response_model=List[GatewayPaymentRecord])
def list_payments(limit: int = Query(default=50, ge=1, le=100)) -> List[GatewayPaymentRecord]:
    """Retrieve recent gateway payments from the in-memory ledger."""
    return GATEWAY.get_payments(limit=limit)


@router.get("/payments/{ref}")
def get_payment_by_ref(ref: str) -> Dict[str, Any]:
    """Retrieve stateful payment status by backend reference ID or payment ID."""
    flow = PAYMENT_FLOW.get_payment(ref)
    if not flow:
        # Check standard ledger as fallback
        with GATEWAY._lock:
            rec = next((p for p in GATEWAY._ledger if p.payment_id == ref or p.reference_id == ref), None)
            if rec:
                return rec.model_dump()
        raise HTTPException(status_code=404, detail=f"Payment reference '{ref}' not found.")

    return {
        "reference_id": flow.reference_id,
        "payment_id": flow.payment_id,
        "state": flow.state.value,
        "from_account": flow.from_account,
        "to_account": flow.to_account,
        "amount": flow.amount,
        "decision": flow.decision,
        "risk_score": flow.risk_score,
        "reasons": [r.model_dump() for r in flow.reasons],
        "ring_id": flow.ring_id,
        "created_at": flow.created_at,
        "updated_at": flow.updated_at,
        "message": flow.message,
        "fraud_check_ms": flow.fraud_check_ms,
        "total_ms": flow.total_ms,
        "demo_otp": flow.demo_otp,
    }


@router.get("/payments/{ref}/receipt")
def get_payment_receipt(ref: str) -> Dict[str, Any]:
    """Retrieve structured JSON receipt for a completed or resolved payment."""
    flow = PAYMENT_FLOW.get_payment(ref)
    if not flow:
        raise HTTPException(status_code=404, detail=f"Payment reference '{ref}' not found.")

    payer = GATEWAY.get_account(flow.from_account)
    payee = GATEWAY.get_account(flow.to_account)
    payer_name = payer.name if payer else "Simulated Payer"
    payee_name = payee.name if payee else "Simulated Payee"

    return PAYMENT_FLOW.build_receipt(flow, payer_name=payer_name, payee_name=payee_name)


@router.post("/reset")
def reset_gateway() -> Dict[str, str]:
    """Restore initial seeded account balances and clear the gateway ledger."""
    GATEWAY.reset()
    return {"status": "ok", "message": "Gateway balances and ledger reset"}
