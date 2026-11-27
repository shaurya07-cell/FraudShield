"""Transaction stream generator with realistic honest patterns and fraud attack scenarios."""
import math
import random
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set

from app.schemas import Transaction

# 500 accounts: ACC_0000-ACC_0399 honest, ACC_0400-ACC_0499 fraud pool
ALL_ACCOUNTS: List[str] = [f"ACC_{i:04d}" for i in range(500)]
HONEST_ACCOUNTS: List[str] = [f"ACC_{i:04d}" for i in range(400)]
FRAUD_ACCOUNTS: List[str] = [f"ACC_{i:04d}" for i in range(400, 500)]

# Hard negative entities: Merchants, Family devices, Employers
MERCHANT_ACCOUNTS: List[str] = [f"ACC_{i:04d}" for i in range(10, 25)]
EMPLOYER_ACCOUNTS: List[str] = [f"ACC_{i:04d}" for i in range(30, 35)]
FAMILY_DEVICES: Dict[str, List[str]] = {
    f"DEV_FAMILY_{k}": [f"ACC_{40 + k*3 + j:04d}" for j in range(3)]
    for k in range(8)
}

# Global set holding ground truth for fraud transactions
FRAUD_TXN_IDS: Set[str] = set()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ip_from_account(account_id: str) -> str:
    num = int(account_id.split("_")[1])
    return f"192.168.{num // 256}.{num % 256}"


def normal_txn() -> Transaction:
    """Standard legitimate consumer payment with lognormal amount."""
    sender, receiver = random.sample(HONEST_ACCOUNTS, 2)
    amount = round(random.lognormvariate(math.log(665), 0.75), 2)
    amount = max(amount, 10.0)

    txn = Transaction(
        txn_id=f"TXN_{uuid.uuid4().hex[:12]}",
        timestamp=_utc_now_iso(),
        sender_id=sender,
        receiver_id=receiver,
        amount=amount,
        device_id=f"DEV_{sender}",
        ip=_ip_from_account(sender),
        channel="UPI",
    )
    return txn


def merchant_txn(merchant_id: Optional[str] = None) -> Transaction:
    """Hard negative: legitimate payment to a high-volume merchant (creates high fan-in)."""
    merchant = merchant_id or random.choice(MERCHANT_ACCOUNTS)
    sender = random.choice([acc for acc in HONEST_ACCOUNTS if acc != merchant])
    amount = round(random.uniform(50.0, 1800.0), 2)

    return Transaction(
        txn_id=f"TXN_MERCH_{uuid.uuid4().hex[:12]}",
        timestamp=_utc_now_iso(),
        sender_id=sender,
        receiver_id=merchant,
        amount=amount,
        device_id=f"DEV_{sender}",
        ip=_ip_from_account(sender),
        channel="UPI",
    )


def family_txn() -> Transaction:
    """Hard negative: legitimate transaction using a shared household/family device."""
    device_id, members = random.choice(list(FAMILY_DEVICES.items()))
    sender = random.choice(members)
    receiver = random.choice([acc for acc in HONEST_ACCOUNTS if acc not in members])
    amount = round(random.uniform(80.0, 1500.0), 2)

    return Transaction(
        txn_id=f"TXN_FAM_{uuid.uuid4().hex[:12]}",
        timestamp=_utc_now_iso(),
        sender_id=sender,
        receiver_id=receiver,
        amount=amount,
        device_id=device_id,
        ip="192.168.10.1",
        channel="UPI",
    )


def salary_burst(employer_id: Optional[str] = None, count: int = 12) -> List[Transaction]:
    """Hard negative: legitimate employer payroll burst to multiple employees."""
    employer = employer_id or random.choice(EMPLOYER_ACCOUNTS)
    employees = random.sample([acc for acc in HONEST_ACCOUNTS if acc != employer], count)
    txns = []

    for emp in employees:
        amt = round(random.uniform(15000.0, 45000.0), 2)
        txn = Transaction(
            txn_id=f"TXN_PAY_{uuid.uuid4().hex[:12]}",
            timestamp=_utc_now_iso(),
            sender_id=employer,
            receiver_id=emp,
            amount=amt,
            device_id=f"DEV_CORP_{employer}",
            ip=_ip_from_account(employer),
            channel="UPI",
        )
        txns.append(txn)

    return txns


def velocity_attack(
    n: int = 15,
    sender: Optional[str] = None,
    compromised: bool = False,
    receiver_pool: Optional[List[str]] = None,
) -> List[Transaction]:
    """Rapid sequence of payments from a fraud account or compromised honest account."""
    if sender is not None:
        fraud_sender = sender
    elif compromised:
        fraud_sender = random.choice(HONEST_ACCOUNTS)
    else:
        fraud_sender = random.choice(FRAUD_ACCOUNTS)

    pool = receiver_pool or HONEST_ACCOUNTS
    receivers = random.sample([acc for acc in pool if acc != fraud_sender], n)
    txns: List[Transaction] = []

    for receiver in receivers:
        amount = round(random.uniform(4800.0, 4999.0), 2)
        txn = Transaction(
            txn_id=f"TXN_VEL_{uuid.uuid4().hex[:12]}",
            timestamp=_utc_now_iso(),
            sender_id=fraud_sender,
            receiver_id=receiver,
            amount=amount,
            device_id=f"DEV_{fraud_sender}",
            ip=_ip_from_account(fraud_sender),
            channel="UPI",
        )
        FRAUD_TXN_IDS.add(txn.txn_id)
        txns.append(txn)

    return txns


def ring_attack(
    size: int = 5,
    laps: int = 3,
    accounts: Optional[List[str]] = None,
    shared_device: bool = True,
    decay: float = 0.98,
    base_amount: float = 50000.0,
) -> List[Transaction]:
    """Fraud ring cycling funds among colluding accounts with optional device sharing."""
    if accounts is not None:
        ring_accounts = accounts
    else:
        ring_accounts = random.sample(FRAUD_ACCOUNTS, size)

    shared_dev_id = f"DEV_RING_{uuid.uuid4().hex[:8]}" if shared_device else None
    shared_ip = "10.99.0.1"

    txns: List[Transaction] = []
    current_amount = base_amount

    for _ in range(laps):
        for i in range(len(ring_accounts)):
            sender = ring_accounts[i]
            receiver = ring_accounts[(i + 1) % len(ring_accounts)]
            current_amount = round(current_amount * decay, 2)

            device_id = shared_dev_id if shared_device else f"DEV_{sender}_{uuid.uuid4().hex[:4]}"
            ip = shared_ip if shared_device else _ip_from_account(sender)

            txn = Transaction(
                txn_id=f"TXN_RING_{uuid.uuid4().hex[:12]}",
                timestamp=_utc_now_iso(),
                sender_id=sender,
                receiver_id=receiver,
                amount=current_amount,
                device_id=device_id,
                ip=ip,
                channel="UPI",
            )
            FRAUD_TXN_IDS.add(txn.txn_id)
            txns.append(txn)

    return txns


def fanout_cashout(
    mules: int = 8,
    mule_accounts: Optional[List[str]] = None,
    cashout_account: Optional[str] = None,
) -> List[Transaction]:
    """Mule network: victim payments aggregated by mules and forwarded to cash-out hub."""
    victims = random.sample(HONEST_ACCOUNTS, mules)

    if mule_accounts is not None and cashout_account is not None:
        mules_list = mule_accounts
        cashout = cashout_account
    else:
        fraud_selection = random.sample(FRAUD_ACCOUNTS, mules + 1)
        mules_list = fraud_selection[:mules]
        cashout = fraud_selection[mules]

    txns: List[Transaction] = []

    # Step 1: Victims pay mule accounts
    mule_amounts = []
    for i in range(mules):
        amt = round(random.uniform(5000.0, 10000.0), 2)
        mule_amounts.append(amt)
        txn = Transaction(
            txn_id=f"TXN_VIC_{uuid.uuid4().hex[:12]}",
            timestamp=_utc_now_iso(),
            sender_id=victims[i],
            receiver_id=mules_list[i],
            amount=amt,
            device_id=f"DEV_{victims[i]}",
            ip=_ip_from_account(victims[i]),
            channel="UPI",
        )
        FRAUD_TXN_IDS.add(txn.txn_id)
        txns.append(txn)

    # Step 2: Each mule forwards ~90% to the single cash-out account
    for i in range(mules):
        forward_amt = round(mule_amounts[i] * 0.90, 2)
        txn = Transaction(
            txn_id=f"TXN_MULE_{uuid.uuid4().hex[:12]}",
            timestamp=_utc_now_iso(),
            sender_id=mules_list[i],
            receiver_id=cashout,
            amount=forward_amt,
            device_id=f"DEV_{mules_list[i]}",
            ip=_ip_from_account(mules_list[i]),
            channel="UPI",
        )
        FRAUD_TXN_IDS.add(txn.txn_id)
        txns.append(txn)

    return txns


def stealth_fraud_txn(sender: Optional[str] = None) -> Transaction:
    """Hard positive: fraud transaction disguised as ordinary legitimate payment."""
    fraud_sender = sender or random.choice(ALL_ACCOUNTS)
    receiver = random.choice([acc for acc in ALL_ACCOUNTS if acc != fraud_sender])
    # Normal consumer amount and standard device
    amount = round(random.uniform(120.0, 850.0), 2)

    txn = Transaction(
        txn_id=f"TXN_STL_{uuid.uuid4().hex[:12]}",
        timestamp=_utc_now_iso(),
        sender_id=fraud_sender,
        receiver_id=receiver,
        amount=amount,
        device_id=f"DEV_CLEAN_{uuid.uuid4().hex[:6]}",
        ip=_ip_from_account(fraud_sender),
        channel="UPI",
    )
    FRAUD_TXN_IDS.add(txn.txn_id)
    return txn


def scenario(name: str) -> List[Transaction]:
    if name == "normal":
        return [normal_txn()]
    elif name == "velocity_attack":
        return velocity_attack()
    elif name == "ring_attack":
        return ring_attack()
    elif name == "fanout_cashout":
        return fanout_cashout()
    else:
        raise ValueError(f"Unknown scenario: {name}")
