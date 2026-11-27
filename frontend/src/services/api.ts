import type {
  GatewayAccount,
  GatewayConfirmResponse,
  GatewayPaymentRecord,
  GatewayPayResponse,
  GraphPayload,
  OperationalMetrics,
  RazorpayConfig,
  RazorpayCreateOrderRequest,
  RazorpayCreateOrderResponse,
  RazorpayPaymentRecord,
  RazorpayVerifyRequest,
  RazorpayVerifyResponse,
  ScoredTransaction,
} from '../types/fraud';

const defaultHost = typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '127.0.0.1';
const envBase = import.meta.env.VITE_API_BASE as string | undefined;
export const API_BASE = envBase ? envBase.replace(/\/+$/, '') : `http://${defaultHost}:8000`;
const WS_BASE = envBase
  ? API_BASE.replace(/^http/, 'ws')
  : `ws://${defaultHost}:8000`;

export async function fetchMetrics(): Promise<OperationalMetrics> {
  const res = await fetch(`${API_BASE}/metrics`);
  if (!res.ok) {
    throw new Error(`Failed to fetch metrics: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchGraph(): Promise<GraphPayload> {
  const res = await fetch(`${API_BASE}/graph`);
  if (!res.ok) {
    throw new Error(`Failed to fetch graph data: ${res.statusText}`);
  }
  return res.json();
}

export async function fetchRecentTransactions(): Promise<ScoredTransaction[]> {
  const res = await fetch(`${API_BASE}/transactions/recent`);
  if (!res.ok) {
    throw new Error(`Failed to fetch transactions: ${res.statusText}`);
  }
  return res.json();
}

export async function runScenario(scenario: string): Promise<{
  scenario: string;
  count: number;
  allowed: number;
  review: number;
  blocked: number;
}> {
  const res = await fetch(`${API_BASE}/simulate/${scenario}`, {
    method: 'POST',
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to run scenario ${scenario}`);
  }
  return res.json();
}

export async function resetSystem(): Promise<void> {
  const res = await fetch(`${API_BASE}/reset`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to reset system: ${res.statusText}`);
  }
}

export interface ScorePaymentRequest {
  sender_id: string;
  receiver_id: string;
  amount: number;
  device_id?: string;
  ip?: string;
  channel?: string;
}

export async function scorePayment(payment: ScorePaymentRequest): Promise<ScoredTransaction> {
  const payload = {
    txn_id: `TXN_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    sender_id: payment.sender_id.trim(),
    receiver_id: payment.receiver_id.trim(),
    amount: payment.amount,
    device_id: payment.device_id || `DEV_${Math.random().toString(36).substring(2, 8)}`,
    ip: payment.ip || '192.168.1.1',
    channel: payment.channel || 'UPI',
  };

  const res = await fetch(`${API_BASE}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Can't reach the scoring service at ${API_BASE}. Check that the backend is running, then retry.`);
  }

  return res.json();
}

// --- Gateway APIs ---

export async function fetchGatewayAccount(accountId: string): Promise<GatewayAccount> {
  const res = await fetch(`${API_BASE}/gateway/accounts/${encodeURIComponent(accountId.trim())}`);
  if (!res.ok) {
    throw new Error(`Account '${accountId}' not found in gateway.`);
  }
  return res.json();
}

export async function fetchGatewayAccounts(limit: number = 20): Promise<GatewayAccount[]> {
  const res = await fetch(`${API_BASE}/gateway/accounts?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to list gateway accounts.`);
  }
  return res.json();
}

export async function fetchGatewayPayments(limit: number = 50): Promise<GatewayPaymentRecord[]> {
  const res = await fetch(`${API_BASE}/gateway/payments?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to retrieve gateway payment ledger.`);
  }
  return res.json();
}

export interface SubmitGatewayPayRequest {
  from_account: string;
  to_account: string;
  amount: number;
  device_id?: string;
  note?: string;
}

export async function submitGatewayPay(req: SubmitGatewayPayRequest): Promise<GatewayPayResponse> {
  const res = await fetch(`${API_BASE}/gateway/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from_account: req.from_account.trim(),
      to_account: req.to_account.trim(),
      amount: req.amount,
      device_id: req.device_id,
      note: req.note,
    }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Gateway payment failed.`);
  }

  return res.json();
}

export async function confirmGatewayPayment(paymentId: string, otp: string): Promise<GatewayConfirmResponse> {
  const res = await fetch(`${API_BASE}/gateway/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payment_id: paymentId,
      otp: otp.trim(),
    }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Payment confirmation failed.`);
  }

  return res.json();
}

export interface PaymentReceipt {
  receipt_number: string;
  reference_id: string;
  payment_id: string;
  status: string;
  timestamp: string;
  payer: {
    account_id: string;
    name: string;
  };
  payee: {
    account_id: string;
    name: string;
  };
  amount: number;
  currency: string;
  payment_mode: string;
  decision?: string;
  risk_score: number;
  reasons: Array<{ rule: string; detail: string; weight: number }>;
  fraud_verified: boolean;
  message: string;
}

export async function fetchPaymentReceipt(referenceId: string): Promise<PaymentReceipt> {
  const res = await fetch(`${API_BASE}/payments/${encodeURIComponent(referenceId)}/receipt`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Receipt not available.');
  }
  return res.json();
}

export async function resetGateway(): Promise<void> {
  const res = await fetch(`${API_BASE}/gateway/reset`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Failed to reset gateway.`);
  }
}

// --- WebSocket Streaming ---

export function subscribeToLiveStream(
  onTransaction: (txn: ScoredTransaction) => void,
  onStatusChange: (status: 'connected' | 'reconnecting') => void
): () => void {
  let ws: WebSocket | null = null;
  let isClosedManually = false;
  let reconnectTimer: any = null;
  let retryCount = 0;

  function connect() {
    if (isClosedManually) return;
    onStatusChange('reconnecting');

    try {
      ws = new WebSocket(`${WS_BASE}/stream`);

      ws.onopen = () => {
        retryCount = 0;
        onStatusChange('connected');
      };

      ws.onmessage = (event) => {
        try {
          const txn: ScoredTransaction = JSON.parse(event.data);
          onTransaction(txn);
        } catch (e) {
          console.error('Error parsing live transaction:', e);
        }
      };

      ws.onerror = () => {
        onStatusChange('reconnecting');
      };

      ws.onclose = () => {
        if (!isClosedManually) {
          onStatusChange('reconnecting');
          const delay = Math.min(1000 * Math.pow(1.5, retryCount), 5000);
          retryCount += 1;
          reconnectTimer = setTimeout(connect, delay);
        }
      };
    } catch {
      onStatusChange('reconnecting');
      reconnectTimer = setTimeout(connect, 2000);
    }
  }

  connect();

  return () => {
    isClosedManually = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
  };
}

// --- Razorpay Test Mode APIs ---

export async function fetchRazorpayConfig(): Promise<RazorpayConfig> {
  const res = await fetch(`${API_BASE}/razorpay/config`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Razorpay config: ${res.statusText}`);
  }
  return res.json();
}

export async function createRazorpayOrder(req: RazorpayCreateOrderRequest): Promise<RazorpayCreateOrderResponse> {
  const res = await fetch(`${API_BASE}/razorpay/create-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Failed to create Razorpay order (${res.status})`);
  }
  return res.json();
}

export async function verifyRazorpayPayment(req: RazorpayVerifyRequest): Promise<RazorpayVerifyResponse> {
  const res = await fetch(`${API_BASE}/razorpay/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.detail || `Payment verification failed (${res.status})`);
  }
  return res.json();
}

export async function fetchRazorpayPayments(limit = 50): Promise<RazorpayPaymentRecord[]> {
  const res = await fetch(`${API_BASE}/razorpay/payments?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch Razorpay payments: ${res.statusText}`);
  }
  return res.json();
}

