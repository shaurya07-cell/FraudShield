from typing import List, Optional
from pydantic import BaseModel, Field


class Transaction(BaseModel):
    txn_id: str
    timestamp: str
    sender_id: str
    receiver_id: str
    amount: float
    device_id: str
    ip: str
    channel: str = "UPI"


class Reason(BaseModel):
    rule: str
    detail: str
    weight: int


class ScoredTransaction(BaseModel):
    txn_id: str
    timestamp: str
    sender_id: str
    receiver_id: str
    amount: float
    risk_score: int = Field(..., ge=0, le=100)
    decision: str  # ALLOW (0-39) / REVIEW (40-69) / BLOCK (70-100)
    reasons: List[Reason] = Field(default_factory=list)
    ring_id: Optional[str] = None
    latency_ms: float = 0.0
