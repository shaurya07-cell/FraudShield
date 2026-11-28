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
  model_scores?: Record<string, number> | null;
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
  holder_name?: string | null;
}

export interface ResolvePayeeResponse {
  found: boolean;
  handle: string;
  kind?: 'account' | 'vpa' | null;
  display_name?: string | null;
}

export interface GatewayPaymentRecord {
  payment_id: string;
  reference_id?: string;
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
  reference_id?: string;
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
  reference_id?: string;
  status: string;
  message: string;
  sender_balance_after: number | null;
  receiver_balance_after: number | null;
}

export interface RazorpayConfig {
  enabled: boolean;
  mode: 'test' | 'live';
}

export interface RazorpayCreateOrderRequest {
  customer_id: string;
  payee_id?: string;
  amount_inr: number;
  device_id?: string;
}

export interface RazorpayCreateOrderResponse {
  status: 'ORDER_CREATED' | 'BLOCKED';
  order_id?: string | null;
  key_id?: string | null;
  amount?: number | null;
  decision: Decision;
  risk_score: number;
  reasons: Reason[];
  requires_extra_verification: boolean;
  model_scores?: Record<string, number> | null;
  message?: string | null;
}

export interface RazorpayVerifyRequest {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayVerifyResponse {
  status: 'VERIFIED' | 'TAMPERED';
  order_id: string;
  payment_id: string;
  message: string;
}

export interface RazorpayPaymentRecord {
  order_id: string;
  payment_id?: string | null;
  status: 'ORDER_CREATED' | 'BLOCKED' | 'VERIFIED' | 'TAMPERED' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED';
  decision?: Decision | null;
  risk_score: number;
  reasons: Reason[];
  amount: number;
  created_at: string;
}
