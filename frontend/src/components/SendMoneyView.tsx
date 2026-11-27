import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchGatewayAccount,
  fetchGatewayPayments,
  submitGatewayPay,
  confirmGatewayPayment,
  fetchRazorpayConfig,
  createRazorpayOrder,
  verifyRazorpayPayment,
  fetchRazorpayPayments,
} from '../services/api';
import type {
  Decision,
  GatewayAccount,
  GatewayPaymentRecord,
  GatewayPayResponse,
  RazorpayConfig,
  RazorpayPaymentRecord,
  Reason,
} from '../types/fraud';

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

interface RazorpayOutcome {
  status: 'BLOCKED' | 'VERIFIED' | 'FAILED' | 'ORDER_CREATED';
  order_id?: string | null;
  payment_id?: string | null;
  decision: Decision | null;
  risk_score: number;
  reasons: Reason[];
  message: string;
  response_ms?: number;
}

export const SendMoneyView: React.FC = () => {
  // Gateway mode: simulated or razorpay
  const [gatewayMode, setGatewayMode] = useState<'simulated' | 'razorpay'>('simulated');
  const [razorpayConfig, setRazorpayConfig] = useState<RazorpayConfig | null>(null);

  // Simulated gateway fields
  const [fromAccount, setFromAccount] = useState('ACC_0010');
  const [toAccount, setToAccount] = useState('ACC_0025');
  const [amount, setAmount] = useState('1250');
  const [senderAccount, setSenderAccount] = useState<GatewayAccount | null>(null);
  const [isAccountLoading, setIsAccountLoading] = useState(false);

  // Simulated gateway state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [payResult, setPayResult] = useState<GatewayPayResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [recentPayments, setRecentPayments] = useState<GatewayPaymentRecord[]>([]);

  // Razorpay mode state
  const [rzpCustomerId, setRzpCustomerId] = useState('ACC_0010');
  const [rzpPayeeId, setRzpPayeeId] = useState('MERCHANT_001');
  const [rzpAmount, setRzpAmount] = useState('1250');
  const [rzpLoading, setRzpLoading] = useState(false);
  const [rzpOutcome, setRzpOutcome] = useState<RazorpayOutcome | null>(null);
  const [rzpError, setRzpError] = useState<string | null>(null);
  const [rzpPayments, setRzpPayments] = useState<RazorpayPaymentRecord[]>([]);

  // Load Razorpay config on mount
  useEffect(() => {
    fetchRazorpayConfig()
      .then((cfg) => setRazorpayConfig(cfg))
      .catch(() => setRazorpayConfig({ enabled: false, mode: 'test' }));
  }, []);

  // Fetch simulated sender balance
  const loadSenderAccount = useCallback(async (accId: string) => {
    if (!accId.trim()) {
      setSenderAccount(null);
      return;
    }
    setIsAccountLoading(true);
    try {
      const acc = await fetchGatewayAccount(accId);
      setSenderAccount(acc);
    } catch {
      setSenderAccount(null);
    } finally {
      setIsAccountLoading(false);
    }
  }, []);

  // Fetch simulated ledger
  const loadRecentPayments = useCallback(async () => {
    try {
      const records = await fetchGatewayPayments(10);
      setRecentPayments(records);
    } catch {
      // Silent error during poll
    }
  }, []);

  // Fetch Razorpay ledger
  const loadRazorpayPaymentsLedger = useCallback(async () => {
    try {
      const records = await fetchRazorpayPayments(10);
      setRzpPayments(records);
    } catch {
      // Silent error during poll
    }
  }, []);

  useEffect(() => {
    if (gatewayMode === 'simulated') {
      loadSenderAccount(fromAccount);
    }
  }, [fromAccount, gatewayMode, loadSenderAccount]);

  useEffect(() => {
    if (gatewayMode === 'simulated') {
      loadRecentPayments();
      const interval = setInterval(loadRecentPayments, 3000);
      return () => clearInterval(interval);
    } else {
      loadRazorpayPaymentsLedger();
      const interval = setInterval(loadRazorpayPaymentsLedger, 3000);
      return () => clearInterval(interval);
    }
  }, [gatewayMode, loadRecentPayments, loadRazorpayPaymentsLedger]);

  // Simulated gateway presets
  const handleFillNormal = () => {
    setFromAccount('ACC_0010');
    setToAccount('ACC_0025');
    setAmount('1250');
    setErrorMessage(null);
    setPayResult(null);
  };

  const handleFillSuspicious = () => {
    setFromAccount('ACC_0405');
    setToAccount('ACC_0010');
    setAmount('4950');
    setErrorMessage(null);
    setPayResult(null);
  };

  // Razorpay presets
  const handleFillRzpNormal = () => {
    setRzpCustomerId('ACC_0010');
    setRzpPayeeId('MERCHANT_001');
    setRzpAmount('1250');
    setRzpError(null);
    setRzpOutcome(null);
  };

  const handleFillRzpSuspicious = () => {
    setRzpCustomerId('ACC_0405');
    setRzpPayeeId('MERCHANT_001');
    setRzpAmount('4950');
    setRzpError(null);
    setRzpOutcome(null);
  };

  // Submit simulated payment
  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromAccount.trim() || !toAccount.trim() || !amount.trim()) return;

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setErrorMessage('Please enter a valid transfer amount greater than zero.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setConfirmError(null);

    try {
      const res = await submitGatewayPay({
        from_account: fromAccount,
        to_account: toAccount,
        amount: numAmount,
      });
      setPayResult(res);
      if (res.status === 'PENDING_VERIFICATION' && res.demo_otp) {
        setOtpInput(res.demo_otp);
      }
      loadSenderAccount(fromAccount);
      loadRecentPayments();
    } catch (err: any) {
      setErrorMessage(
        err.message ||
          "Can't reach the gateway service. Check that the backend is running, then retry."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  // Confirm simulated OTP
  const handleConfirmOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payResult || !otpInput.trim()) return;

    setIsConfirming(true);
    setConfirmError(null);

    try {
      const conf = await confirmGatewayPayment(payResult.payment_id, otpInput);
      if (conf.status === 'SUCCESS') {
        setPayResult({
          ...payResult,
          status: 'SUCCESS',
          message: 'Payment confirmed and processed successfully.',
          sender_balance_after: conf.sender_balance_after,
          receiver_balance_after: conf.receiver_balance_after,
        });
        loadSenderAccount(fromAccount);
        loadRecentPayments();
      } else if (conf.status === 'DECLINED') {
        setPayResult({
          ...payResult,
          status: 'DECLINED',
          message: conf.message,
        });
        loadRecentPayments();
      }
    } catch (err: any) {
      setConfirmError(err.message || 'Verification failed. Please check the demo code.');
    } finally {
      setIsConfirming(false);
    }
  };

  // Submit Razorpay flow
  const handleRazorpayPay = async (e: React.FormEvent) => {
    e.preventDefault();
    const numAmount = parseFloat(rzpAmount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setRzpError('Please enter a valid amount greater than zero.');
      return;
    }

    setRzpLoading(true);
    setRzpError(null);
    setRzpOutcome(null);

    const startTime = performance.now();

    try {
      // 1. Create order (runs FraudShield score_transaction pre-check)
      const orderRes = await createRazorpayOrder({
        customer_id: rzpCustomerId.trim(),
        payee_id: rzpPayeeId.trim() || 'MERCHANT_001',
        amount_inr: numAmount,
      });

      const responseMs = performance.now() - startTime;

      // 2. If blocked by fraud checkpoint, do not open checkout
      if (orderRes.status === 'BLOCKED') {
        setRzpOutcome({
          status: 'BLOCKED',
          order_id: null,
          decision: orderRes.decision,
          risk_score: orderRes.risk_score,
          reasons: orderRes.reasons,
          message: orderRes.message || 'Payment blocked: high fraud risk detected.',
          response_ms: responseMs,
        });
        loadRazorpayPaymentsLedger();
        setRzpLoading(false);
        return;
      }

      // 3. ALLOW or REVIEW: Load Razorpay Checkout.js
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        throw new Error('Failed to load Razorpay Checkout script. Check your internet connection.');
      }

      const options = {
        key: orderRes.key_id,
        amount: orderRes.amount,
        currency: 'INR',
        name: 'FraudShield Gateway',
        description: `Order ${orderRes.order_id}`,
        order_id: orderRes.order_id,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          try {
            const verifyStartTime = performance.now();
            const verifyRes = await verifyRazorpayPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            const totalMs = performance.now() - verifyStartTime;

            setRzpOutcome({
              status: verifyRes.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED',
              order_id: response.razorpay_order_id,
              payment_id: response.razorpay_payment_id,
              decision: orderRes.decision,
              risk_score: orderRes.risk_score,
              reasons: orderRes.reasons,
              message: verifyRes.message || 'Payment authorized and verified.',
              response_ms: totalMs,
            });
            loadRazorpayPaymentsLedger();
          } catch (vErr: any) {
            setRzpError(vErr.message || 'Signature verification failed.');
            loadRazorpayPaymentsLedger();
          } finally {
            setRzpLoading(false);
          }
        },
        modal: {
          ondismiss: () => {
            setRzpLoading(false);
            setRzpError('Payment cancelled. Checkout window was closed.');
            loadRazorpayPaymentsLedger();
          },
        },
        prefill: {
          contact: '9999999999',
          email: 'analyst@fraudshield.internal',
        },
        notes: {
          decision: orderRes.decision,
          risk_score: String(orderRes.risk_score),
        },
        theme: {
          color: '#1F4FD8',
        },
      };

      const rzpInstance = new (window as any).Razorpay(options);
      rzpInstance.on('payment.failed', (failResp: any) => {
        setRzpLoading(false);
        const reasonMsg = failResp.error?.description || 'Payment failed or was declined by issuing bank.';
        setRzpError(`Payment failed: ${reasonMsg}`);
        loadRazorpayPaymentsLedger();
      });

      rzpInstance.open();
    } catch (err: any) {
      setRzpLoading(false);
      setRzpError(err.message || 'Failed to initiate Razorpay checkout.');
    }
  };

  const handleResetSimulated = () => {
    setPayResult(null);
    setErrorMessage(null);
    setConfirmError(null);
    setOtpInput('');
    loadSenderAccount(fromAccount);
  };

  const handleResetRazorpay = () => {
    setRzpOutcome(null);
    setRzpError(null);
    loadRazorpayPaymentsLedger();
  };

  const getOutcomeDetails = (status: string) => {
    if (status === 'SUCCESS' || status === 'VERIFIED') {
      return {
        title: 'Payment successful',
        colorBar: 'border-l-[#1E8E5A]',
        textColor: 'text-[#1E8E5A]',
      };
    }
    if (status === 'PENDING_VERIFICATION') {
      return {
        title: 'Needs your confirmation',
        colorBar: 'border-l-[#B7791F]',
        textColor: 'text-[#B7791F]',
      };
    }
    if (status === 'DECLINED' || status === 'BLOCKED' || status === 'TAMPERED') {
      return {
        title: 'Payment declined',
        colorBar: 'border-l-[#C0362C]',
        textColor: 'text-[#C0362C]',
      };
    }
    return {
      title: 'Payment failed',
      colorBar: 'border-l-[#5B6575]',
      textColor: 'text-[#5B6575]',
    };
  };

  return (
    <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] py-6 sm:py-8 px-3 sm:px-4 flex justify-center items-start">
      <div className="w-full max-w-[480px] space-y-4">
        {/* Main payment card */}
        <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-5 sm:p-6">
          {/* Header & Mode Switch */}
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-[18px] font-semibold text-[#1B2433]">Send money</h1>

            {razorpayConfig?.enabled ? (
              <div className="flex bg-[#F4F5F7] p-0.5 rounded-[6px] border border-[#DCE0E7]">
                <button
                  type="button"
                  onClick={() => {
                    setGatewayMode('simulated');
                    setErrorMessage(null);
                  }}
                  className={`px-2.5 py-1 text-[12px] font-medium rounded-[4px] transition-colors ${
                    gatewayMode === 'simulated'
                      ? 'bg-[#FFFFFF] text-[#1B2433] shadow-sm'
                      : 'text-[#5B6575] hover:text-[#1B2433]'
                  }`}
                >
                  Simulated gateway
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setGatewayMode('razorpay');
                    setRzpError(null);
                  }}
                  className={`px-2.5 py-1 text-[12px] font-medium rounded-[4px] transition-colors ${
                    gatewayMode === 'razorpay'
                      ? 'bg-[#FFFFFF] text-[#1F4FD8] shadow-sm'
                      : 'text-[#5B6575] hover:text-[#1B2433]'
                  }`}
                >
                  Razorpay (test mode)
                </button>
              </div>
            ) : (
              <span className="text-[11px] font-medium text-[#5B6575] bg-[#F4F5F7] border border-[#DCE0E7] px-2 py-0.5 rounded-[4px]">
                Simulated gateway
              </span>
            )}
          </div>

          {/* Subtitle or config hint */}
          {!razorpayConfig?.enabled && (
            <p className="text-[11px] text-[#5B6575] mb-3">
              Tip: Add <code className="bg-[#F4F5F7] px-1 py-0.5 rounded text-[10px] text-[#1B2433]">RAZORPAY_KEY_ID</code> in <code className="bg-[#F4F5F7] px-1 py-0.5 rounded text-[10px] text-[#1B2433]">backend/.env</code> to enable Razorpay test mode.
            </p>
          )}

          {/* Razorpay Test Mode Banner */}
          {gatewayMode === 'razorpay' && (
            <div className="mb-4 p-3 bg-[#1F4FD8]/5 border border-[#1F4FD8]/20 rounded-[6px] text-[12px] text-[#1B2433] leading-normal">
              <span className="font-semibold text-[#1F4FD8]">Test mode:</span> no real money is moved. Use{' '}
              <code className="font-mono text-[11px] bg-[#FFFFFF] px-1 py-0.5 rounded border border-[#DCE0E7] text-[#1B2433]">success@razorpay</code> for a successful UPI payment and{' '}
              <code className="font-mono text-[11px] bg-[#FFFFFF] px-1 py-0.5 rounded border border-[#DCE0E7] text-[#1B2433]">failure@razorpay</code> for a failed one.
            </div>
          )}

          {/* --- SIMULATED GATEWAY FORM --- */}
          {gatewayMode === 'simulated' && (
            <>
              <p className="text-[13px] text-[#5B6575] mb-5 leading-normal">
                Demo account-to-account transfer with real-time fraud checkpoint.
              </p>

              {errorMessage && (
                <div className="mb-4 p-3 bg-[#C0362C]/10 border border-[#C0362C]/20 rounded-[6px] text-[13px] text-[#C0362C]">
                  <p>{errorMessage}</p>
                  <button
                    type="button"
                    onClick={handlePay}
                    className="mt-1 text-[12px] font-semibold underline hover:text-[#991B1B]"
                  >
                    Retry
                  </button>
                </div>
              )}

              {!payResult ? (
                <form onSubmit={handlePay} className="space-y-4">
                  {/* Sender Account */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="from-account" className="text-[12px] font-medium text-[#5B6575]">
                        From account
                      </label>
                      {isAccountLoading ? (
                        <span className="text-[11px] text-[#5B6575]">Checking balance...</span>
                      ) : senderAccount ? (
                        <span className="text-[12px] text-[#1B2433]">
                          Balance: <span className="font-semibold tabular-nums">₹{senderAccount.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-[#5B6575]">Seeded: ACC_0000 - ACC_0499</span>
                      )}
                    </div>
                    <input
                      id="from-account"
                      type="text"
                      required
                      placeholder="e.g. ACC_0010"
                      value={fromAccount}
                      onChange={(e) => setFromAccount(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[13px] text-[#1B2433] placeholder-[#5B6575]/50 focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                    />
                    {senderAccount && (
                      <div className="text-[11px] text-[#5B6575] mt-0.5">
                        Account holder: {senderAccount.name}
                      </div>
                    )}
                  </div>

                  {/* Recipient Account */}
                  <div>
                    <label htmlFor="to-account" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                      To account
                    </label>
                    <input
                      id="to-account"
                      type="text"
                      required
                      placeholder="e.g. ACC_0025"
                      value={toAccount}
                      onChange={(e) => setToAccount(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[13px] text-[#1B2433] placeholder-[#5B6575]/50 focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                    />
                  </div>

                  {/* Amount */}
                  <div>
                    <label htmlFor="amount" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                      Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-[#5B6575] text-[14px]">₹</span>
                      <input
                        id="amount"
                        type="number"
                        step="any"
                        min="1"
                        required
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full pl-7 pr-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] text-[14px] tabular-nums text-[#1B2433] placeholder-[#5B6575]/50 focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                      />
                    </div>
                  </div>

                  {/* Pay Button */}
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isSubmitting ? 'Evaluating payment...' : 'Pay'}
                    </button>
                  </div>

                  {/* Quick Fill Buttons */}
                  <div className="pt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#DCE0E7]">
                    <button
                      type="button"
                      onClick={handleFillNormal}
                      className="text-[12px] text-[#5B6575] hover:text-[#1B2433] transition-colors"
                    >
                      Fill normal payment
                    </button>
                    <button
                      type="button"
                      onClick={handleFillSuspicious}
                      className="text-[12px] text-[#5B6575] hover:text-[#C0362C] transition-colors"
                    >
                      Fill suspicious payment
                    </button>
                  </div>
                </form>
              ) : (
                /* Simulated Result Panel */
                <div className="space-y-4">
                  {(() => {
                    const outcome = getOutcomeDetails(payResult.status);
                    return (
                      <div className={`p-4 bg-[#FFFFFF] border border-[#DCE0E7] border-l-4 ${outcome.colorBar} rounded-[6px]`}>
                        <div className={`text-[16px] font-semibold ${outcome.textColor} mb-1`}>
                          {outcome.title}
                        </div>
                        <p className="text-[13px] text-[#1B2433] leading-normal">{payResult.message}</p>

                        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#DCE0E7] text-[12px] text-[#5B6575] tabular-nums">
                          <div>
                            Fraud check: <span className="font-semibold text-[#1B2433]">{payResult.fraud_check_ms.toFixed(1)} ms</span>
                          </div>
                          <div>
                            Total latency: <span className="font-semibold text-[#1B2433]">{payResult.total_ms.toFixed(1)} ms</span>
                          </div>
                          <div>
                            Risk score: <span className="font-semibold text-[#1B2433]">{payResult.risk_score}</span> / 100
                          </div>
                          <div>
                            Sender balance:{' '}
                            <span className="font-semibold text-[#1B2433]">
                              ₹{payResult.sender_balance_after !== null && payResult.sender_balance_after !== undefined
                                ? payResult.sender_balance_after.toLocaleString('en-IN', { minimumFractionDigits: 2 })
                                : '—'}
                            </span>
                          </div>
                        </div>

                        {payResult.ring_id && (
                          <div className="mt-2 text-[12px] text-[#C0362C] font-mono">
                            Ring detected: {payResult.ring_id}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* OTP Input for PENDING_VERIFICATION */}
                  {payResult.status === 'PENDING_VERIFICATION' && (
                    <div className="p-4 bg-[#F4F5F7] border border-[#DCE0E7] rounded-[6px] space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-medium text-[#1B2433]">Verification required</span>
                        <span className="text-[12px] font-mono font-semibold text-[#1F4FD8]">
                          Demo code: {payResult.demo_otp}
                        </span>
                      </div>
                      <p className="text-[12px] text-[#5B6575]">
                        Enter the demo verification code above to authorize fund movement.
                      </p>

                      {confirmError && (
                        <div className="p-2 bg-[#C0362C]/10 border border-[#C0362C]/20 rounded-[4px] text-[12px] text-[#C0362C]">
                          {confirmError}
                        </div>
                      )}

                      <form onSubmit={handleConfirmOtp} className="flex gap-2">
                        <input
                          type="text"
                          maxLength={6}
                          required
                          placeholder="Enter 6-digit OTP"
                          value={otpInput}
                          onChange={(e) => setOtpInput(e.target.value.trim())}
                          className="flex-1 px-3 py-1.5 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[14px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
                        />
                        <button
                          type="submit"
                          disabled={isConfirming}
                          className="px-4 py-1.5 bg-[#1F4FD8] text-[#FFFFFF] text-[13px] font-medium rounded-[6px] hover:bg-[#183EB0] disabled:opacity-50 transition-colors whitespace-nowrap"
                        >
                          {isConfirming ? 'Verifying...' : 'Confirm payment'}
                        </button>
                      </form>
                    </div>
                  )}

                  {/* Evaluated reasons */}
                  <div>
                    <h2 className="text-[13px] font-medium text-[#1B2433] mb-2">Evaluated reasons</h2>
                    {payResult.reasons.length === 0 ? (
                      <p className="text-[12px] text-[#5B6575]">
                        No fraud triggers detected. Transaction passed standard velocity, amount, and topology checks.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {payResult.reasons.map((r, i) => (
                          <div
                            key={i}
                            className="p-2.5 bg-[#F4F5F7] border border-[#DCE0E7] rounded-[4px] text-[12px]"
                          >
                            <div className="font-medium text-[#1B2433]">{r.detail}</div>
                            <div className="text-[#5B6575] text-[11px] mt-0.5">
                              {r.rule} (weight {r.weight})
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={handleResetSimulated}
                      className="w-full py-2 px-4 bg-[#FFFFFF] border border-[#DCE0E7] text-[#1B2433] text-[14px] font-medium rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
                    >
                      New payment
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* --- RAZORPAY TEST MODE FORM --- */}
          {gatewayMode === 'razorpay' && (
            <>
              <p className="text-[13px] text-[#5B6575] mb-5 leading-normal">
                Real payment checkout in Razorpay test mode with FraudShield fraud checkpoint.
              </p>

              {rzpError && (
                <div className="mb-4 p-3 bg-[#C0362C]/10 border border-[#C0362C]/20 rounded-[6px] text-[13px] text-[#C0362C]">
                  <p>{rzpError}</p>
                </div>
              )}

              {!rzpOutcome ? (
                <form onSubmit={handleRazorpayPay} className="space-y-4">
                  {/* Customer Identifier */}
                  <div>
                    <label htmlFor="rzp-customer" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                      Customer ID / Account
                    </label>
                    <input
                      id="rzp-customer"
                      type="text"
                      required
                      placeholder="e.g. ACC_0010"
                      value={rzpCustomerId}
                      onChange={(e) => setRzpCustomerId(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[13px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                    />
                  </div>

                  {/* Payee / Merchant */}
                  <div>
                    <label htmlFor="rzp-payee" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                      Payee / Merchant ID
                    </label>
                    <input
                      id="rzp-payee"
                      type="text"
                      required
                      placeholder="e.g. MERCHANT_001"
                      value={rzpPayeeId}
                      onChange={(e) => setRzpPayeeId(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[13px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                    />
                  </div>

                  {/* Amount */}
                  <div>
                    <label htmlFor="rzp-amount" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                      Amount (INR)
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-[#5B6575] text-[14px]">₹</span>
                      <input
                        id="rzp-amount"
                        type="number"
                        step="any"
                        min="1"
                        required
                        placeholder="0.00"
                        value={rzpAmount}
                        onChange={(e) => setRzpAmount(e.target.value)}
                        className="w-full pl-7 pr-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] text-[14px] tabular-nums text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                      />
                    </div>
                  </div>

                  {/* Pay Button */}
                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={rzpLoading}
                      className="w-full py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {rzpLoading ? 'Evaluating fraud risk...' : 'Proceed to Razorpay Checkout'}
                    </button>
                  </div>

                  {/* Quick Fill Buttons */}
                  <div className="pt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#DCE0E7]">
                    <button
                      type="button"
                      onClick={handleFillRzpNormal}
                      className="text-[12px] text-[#5B6575] hover:text-[#1B2433] transition-colors"
                    >
                      Fill normal payment
                    </button>
                    <button
                      type="button"
                      onClick={handleFillRzpSuspicious}
                      className="text-[12px] text-[#5B6575] hover:text-[#C0362C] transition-colors"
                    >
                      Fill suspicious payment
                    </button>
                  </div>
                </form>
              ) : (
                /* Razorpay Result Card */
                <div className="space-y-4">
                  {(() => {
                    const outcome = getOutcomeDetails(rzpOutcome.status);
                    return (
                      <div className={`p-4 bg-[#FFFFFF] border border-[#DCE0E7] border-l-4 ${outcome.colorBar} rounded-[6px]`}>
                        <div className={`text-[16px] font-semibold ${outcome.textColor} mb-1`}>
                          {outcome.title}
                        </div>
                        <p className="text-[13px] text-[#1B2433] leading-normal">{rzpOutcome.message}</p>

                        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#DCE0E7] text-[12px] text-[#5B6575] tabular-nums">
                          <div>
                            Decision:{' '}
                            <span className="font-semibold text-[#1B2433]">
                              {rzpOutcome.decision || 'NONE'}
                            </span>
                          </div>
                          <div>
                            Risk score:{' '}
                            <span className="font-semibold text-[#1B2433]">
                              {rzpOutcome.risk_score}
                            </span>{' '}
                            / 100
                          </div>
                          {rzpOutcome.response_ms && (
                            <div>
                              Response time:{' '}
                              <span className="font-semibold text-[#1B2433]">
                                {rzpOutcome.response_ms.toFixed(1)} ms
                              </span>
                            </div>
                          )}
                          {rzpOutcome.order_id && (
                            <div className="truncate font-mono text-[11px]" title={rzpOutcome.order_id}>
                              Order: <span className="text-[#1B2433]">{rzpOutcome.order_id}</span>
                            </div>
                          )}
                          {rzpOutcome.payment_id && (
                            <div className="truncate font-mono text-[11px]" title={rzpOutcome.payment_id}>
                              Payment: <span className="text-[#1B2433]">{rzpOutcome.payment_id}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Evaluated reasons */}
                  <div>
                    <h2 className="text-[13px] font-medium text-[#1B2433] mb-2">Evaluated reasons</h2>
                    {rzpOutcome.reasons.length === 0 ? (
                      <p className="text-[12px] text-[#5B6575]">
                        No fraud triggers detected. Transaction passed standard velocity, amount, and topology checks.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {rzpOutcome.reasons.map((r, i) => (
                          <div
                            key={i}
                            className="p-2.5 bg-[#F4F5F7] border border-[#DCE0E7] rounded-[4px] text-[12px]"
                          >
                            <div className="font-medium text-[#1B2433]">{r.detail}</div>
                            <div className="text-[#5B6575] text-[11px] mt-0.5">
                              {r.rule} (weight {r.weight})
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={handleResetRazorpay}
                      className="w-full py-2 px-4 bg-[#FFFFFF] border border-[#DCE0E7] text-[#1B2433] text-[14px] font-medium rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
                    >
                      New payment
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* --- RECENT PAYMENTS LEDGER --- */}
        {gatewayMode === 'simulated' ? (
          <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-medium text-[#1B2433]">Recent simulated payments</h2>
              <span className="text-[11px] text-[#5B6575] tabular-nums">
                {recentPayments.length} recorded
              </span>
            </div>

            {recentPayments.length === 0 ? (
              <p className="text-[12px] text-[#5B6575] text-center py-4">
                No gateway transactions yet. Submit a payment above.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#DCE0E7] text-[#5B6575]">
                      <th className="py-1.5 pr-2 font-normal">From</th>
                      <th className="py-1.5 px-2 font-normal">To</th>
                      <th className="py-1.5 px-2 font-normal text-right">Amount</th>
                      <th className="py-1.5 pl-2 font-normal text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DCE0E7]">
                    {recentPayments.map((p) => {
                      let badgeClass = 'bg-[#1E8E5A]/10 text-[#1E8E5A]';
                      let statusLabel = 'Success';

                      if (p.status === 'PENDING_VERIFICATION') {
                        badgeClass = 'bg-[#B7791F]/10 text-[#B7791F]';
                        statusLabel = 'Pending';
                      } else if (p.status === 'DECLINED') {
                        badgeClass = 'bg-[#C0362C]/10 text-[#C0362C]';
                        statusLabel = 'Declined';
                      } else if (p.status === 'FAILED') {
                        badgeClass = 'bg-[#5B6575]/10 text-[#5B6575]';
                        statusLabel = 'Failed';
                      }

                      return (
                        <tr key={p.payment_id} className="hover:bg-[#F4F5F7] transition-colors">
                          <td className="py-1.5 pr-2 font-mono text-[#1B2433]">{p.from_account}</td>
                          <td className="py-1.5 px-2 font-mono text-[#1B2433]">{p.to_account}</td>
                          <td className="py-1.5 px-2 text-right font-medium tabular-nums text-[#1B2433]">
                            ₹{p.amount.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                          </td>
                          <td className="py-1.5 pl-2 text-right">
                            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badgeClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          /* Razorpay payments table */
          <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-medium text-[#1B2433]">Razorpay payments</h2>
              <span className="text-[11px] text-[#5B6575] tabular-nums">
                {rzpPayments.length} recorded
              </span>
            </div>

            {rzpPayments.length === 0 ? (
              <p className="text-[12px] text-[#5B6575] text-center py-4">
                No Razorpay transactions recorded yet. Initiate a checkout above.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#DCE0E7] text-[#5B6575]">
                      <th className="py-1.5 pr-2 font-normal">Order ID</th>
                      <th className="py-1.5 px-2 font-normal text-right">Amount</th>
                      <th className="py-1.5 px-2 font-normal text-center">Decision</th>
                      <th className="py-1.5 pl-2 font-normal text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DCE0E7]">
                    {rzpPayments.map((p) => {
                      let badgeClass = 'bg-[#1E8E5A]/10 text-[#1E8E5A]';
                      let statusLabel: string = p.status;

                      if (p.status === 'VERIFIED' || p.status === 'CAPTURED') {
                        badgeClass = 'bg-[#1E8E5A]/10 text-[#1E8E5A]';
                        statusLabel = 'Verified';
                      } else if (p.status === 'ORDER_CREATED') {
                        badgeClass = 'bg-[#1F4FD8]/10 text-[#1F4FD8]';
                        statusLabel = 'Created';
                      } else if (p.status === 'BLOCKED' || p.status === 'TAMPERED' || p.status === 'FAILED') {
                        badgeClass = 'bg-[#C0362C]/10 text-[#C0362C]';
                        statusLabel = p.status === 'BLOCKED' ? 'Blocked' : p.status === 'TAMPERED' ? 'Tampered' : 'Failed';
                      }

                      return (
                        <tr key={p.order_id} className="hover:bg-[#F4F5F7] transition-colors">
                          <td className="py-1.5 pr-2 font-mono text-[11px] text-[#1B2433] max-w-[140px] truncate" title={p.order_id}>
                            {p.order_id}
                          </td>
                          <td className="py-1.5 px-2 text-right font-medium tabular-nums text-[#1B2433]">
                            ₹{p.amount.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                          </td>
                          <td className="py-1.5 px-2 text-center">
                            {p.decision ? (
                              <span
                                className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold rounded ${
                                  p.decision === 'ALLOW'
                                    ? 'text-[#1E8E5A]'
                                    : p.decision === 'REVIEW'
                                    ? 'text-[#B7791F]'
                                    : 'text-[#C0362C]'
                                }`}
                              >
                                {p.decision} ({p.risk_score})
                              </span>
                            ) : (
                              <span className="text-[#5B6575] text-[11px]">—</span>
                            )}
                          </td>
                          <td className="py-1.5 pl-2 text-right">
                            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badgeClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
