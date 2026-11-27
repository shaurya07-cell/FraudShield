import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchGatewayAccount,
  fetchGatewayPayments,
  submitGatewayPay,
  confirmGatewayPayment,
} from '../services/api';
import type {
  GatewayAccount,
  GatewayPaymentRecord,
  GatewayPayResponse,
} from '../types/fraud';

export const SendMoneyView: React.FC = () => {
  const [fromAccount, setFromAccount] = useState('ACC_0010');
  const [toAccount, setToAccount] = useState('ACC_0025');
  const [amount, setAmount] = useState('1250');
  const [senderAccount, setSenderAccount] = useState<GatewayAccount | null>(null);
  const [isAccountLoading, setIsAccountLoading] = useState(false);

  // Payment states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [payResult, setPayResult] = useState<GatewayPayResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // OTP confirmation states
  const [otpInput, setOtpInput] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Recent payments ledger
  const [recentPayments, setRecentPayments] = useState<GatewayPaymentRecord[]>([]);

  // Fetch sender balance
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

  // Fetch recent payments ledger
  const loadRecentPayments = useCallback(async () => {
    try {
      const records = await fetchGatewayPayments(10);
      setRecentPayments(records);
    } catch {
      // Silent error during poll
    }
  }, []);

  useEffect(() => {
    loadSenderAccount(fromAccount);
  }, [fromAccount, loadSenderAccount]);

  useEffect(() => {
    loadRecentPayments();
    const interval = setInterval(loadRecentPayments, 3000);
    return () => clearInterval(interval);
  }, [loadRecentPayments]);

  // Form Presets
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

  // Submit payment
  const handlePay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromAccount.trim() || !toAccount.trim() || !amount.trim()) {
      return;
    }

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
      // Auto-prefill demo OTP for tester convenience
      if (res.status === 'PENDING_VERIFICATION' && res.demo_otp) {
        setOtpInput(res.demo_otp);
      }
      // Refresh balance and recent payments
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

  // Confirm verification code
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

  const handleResetForm = () => {
    setPayResult(null);
    setErrorMessage(null);
    setConfirmError(null);
    setOtpInput('');
    loadSenderAccount(fromAccount);
  };

  // Outcome styling
  const getOutcomeDetails = (status: string) => {
    if (status === 'SUCCESS') {
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
    if (status === 'DECLINED') {
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
      <div className="w-full max-w-[460px] space-y-4">
        {/* Main payment card */}
        <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-5 sm:p-6">
          <div className="flex items-center justify-between mb-1">
            <h1 className="text-[18px] font-semibold text-[#1B2433]">Send money</h1>
            <span className="text-[11px] font-medium text-[#5B6575] bg-[#F4F5F7] border border-[#DCE0E7] px-2 py-0.5 rounded-[4px]">
              Simulated gateway
            </span>
          </div>
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
              {/* Sender Account + Live Balance */}
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
            /* Result Panel */
            <div className="space-y-4">
              {(() => {
                const outcome = getOutcomeDetails(payResult.status);
                return (
                  <div className={`p-4 bg-[#FFFFFF] border border-[#DCE0E7] border-l-4 ${outcome.colorBar} rounded-[6px]`}>
                    <div className={`text-[16px] font-semibold ${outcome.textColor} mb-1`}>
                      {outcome.title}
                    </div>
                    <p className="text-[13px] text-[#1B2433] leading-normal">{payResult.message}</p>

                    {/* Operational Telemetry */}
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

              {/* Plain-language reasons */}
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

              {/* Reset / New Payment Button */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleResetForm}
                  className="w-full py-2 px-4 bg-[#FFFFFF] border border-[#DCE0E7] text-[#1B2433] text-[14px] font-medium rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
                >
                  New payment
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Small Recent Payments Ledger */}
        <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-medium text-[#1B2433]">Recent payments</h2>
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
      </div>
    </div>
  );
};
