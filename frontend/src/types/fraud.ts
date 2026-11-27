export type Decision = 'ALLOW' | 'REVIEW' | 'BLOCK';

export interface Reason {
  rule: string;
  detail: string;
  weight: number;
}

export interface ScoredTransaction {
  txn_id: string;
  timestamp: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  risk_score: number;
  decision: Decision;
  reasons: Reason[];
  ring_id: string | null;
  latency_ms: number;
  isNew?: boolean;
}

export interface OperationalMetrics {
  total_txns: number;
  avg_latency_ms: number;
  p99_latency_ms: number;
  tps: number;
  allowed: number;
  review: number;
  blocked: number;
  rings_detected: number;
}

export interface GraphNode {
  id: string;
  risk: number;
  ring_id: string | null;
  txn_count: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface GraphEdge {
  source: string | GraphNode;
  target: string | GraphNode;
  amount: number;
  count: number;
}

export interface DetectedRing {
  ring_id: string;
  members: string[];
  score: number;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rings: DetectedRing[];
}

export interface LatencyHistoryPoint {
  time: string;
  latency: number;
}

export interface GatewayAccount {
  id: string;
  name: string;
  balance: number;
  status: string;
}

export interface GatewayPaymentRecord {
  payment_id: string;
  created_at: string;
  from_account: string;
  to_account: string;
  amount: number;
  status: 'SUCCESS' | 'PENDING_VERIFICATION' | 'DECLINED' | 'FAILED';
  risk_score: number;
  decision: Decision | null;
  reasons: Reason[];
  ring_id: string | null;
  latency_ms: number;
  fraud_check_ms: number;
  demo_otp?: string | null;
  failed_otp_attempts?: number;
}

export interface GatewayPayResponse {
  payment_id: string;
  status: 'SUCCESS' | 'PENDING_VERIFICATION' | 'DECLINED' | 'FAILED';
  decision: Decision | null;
  risk_score: number;
  reasons: Reason[];
  ring_id: string | null;
  fraud_check_ms: number;
  total_ms: number;
  sender_balance_after: number | null;
  receiver_balance_after: number | null;
  message: string;
  demo_otp?: string | null;
}

export interface GatewayConfirmResponse {
  payment_id: string;
  status: string;
  message: string;
  sender_balance_after: number | null;
  receiver_balance_after: number | null;
}
