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
  fetchPaymentReceipt,
  PaymentReceipt,
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
import { DecisionBadge } from './DecisionBadge';
import { Stepper, StepItem } from './Stepper';
import { QrScannerPanel, DecodedUpiData } from './QrScannerPanel';
import { PaymentReceiptModal } from './PaymentReceiptModal';

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) {
      resolve(true);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>('script[src*="checkout.razorpay.com"]');
    if (existing) {
      if ((window as any).Razorpay) {
        resolve(true);
      } else {
        existing.addEventListener('load', () => resolve(true), { once: true });
        existing.addEventListener('error', () => resolve(false), { once: true });
      }
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(true);
    script.onerror = () => {
      script.remove();
      resolve(false);
    };
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

type UpiStep = 'payee' | 'amount' | 'review' | 'processing' | 'result';

interface SendMoneyViewProps {
  onBackToDashboard?: () => void;
  onBackToPayHome?: () => void;
  initialMode?: 'simulated' | 'razorpay';
  autoScan?: boolean;
  selfTransfer?: boolean;
}

export const SendMoneyView: React.FC<SendMoneyViewProps> = ({
  onBackToDashboard,
  onBackToPayHome,
  initialMode,
  autoScan,
  selfTransfer,
}) => {
  // Gateway mode: simulated or razorpay
  const [gatewayMode, setGatewayMode] = useState<'simulated' | 'razorpay'>(initialMode || 'simulated');
  const [razorpayConfig, setRazorpayConfig] = useState<RazorpayConfig | null>(null);

  // Stepped flow state — start at 'payee' (QR scanner is on this step, so autoScan users see it immediately)
  const [step, setStep] = useState<UpiStep>(autoScan ? 'payee' : 'payee');

  // Track autoScan flag so QrScannerPanel renders in camera mode on mount
  const showAutoScan = autoScan ?? false;

  // Simulated gateway fields
  const [fromAccount, setFromAccount] = useState('ACC_0010');
  const [toAccount, setToAccount] = useState(selfTransfer ? 'ACC_0010' : 'success@razorpay');
  const [amount, setAmount] = useState('1250');
  const [senderAccount, setSenderAccount] = useState<GatewayAccount | null>(null);
  const [isAccountLoading, setIsAccountLoading] = useState(false);

  // Simulated gateway processing & results
  const [payResult, setPayResult] = useState<GatewayPayResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [recentPayments, setRecentPayments] = useState<GatewayPaymentRecord[]>([]);
  const [selectedReceipt, setSelectedReceipt] = useState<PaymentReceipt | null>(null);
  const [isReceiptLoading, setIsReceiptLoading] = useState(false);

  // Razorpay mode state
  const [rzpCustomerId] = useState('ACC_0010');
  const [rzpPayeeId, setRzpPayeeId] = useState('success@razorpay');
  const [rzpAmount, setRzpAmount] = useState('1250');
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

  // Fetch recent simulated payments
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

  // Polling with mounted safeguard
  useEffect(() => {
    let isMounted = true;
    if (gatewayMode === 'simulated') {
      fetchGatewayPayments(10)
        .then((records) => {
          if (isMounted) setRecentPayments(records);
        })
        .catch(() => {});
      const interval = setInterval(() => {
        fetchGatewayPayments(10)
          .then((records) => {
            if (isMounted) setRecentPayments(records);
          })
          .catch(() => {});
      }, 3000);
      return () => {
        isMounted = false;
        clearInterval(interval);
      };
    } else {
      fetchRazorpayPayments(10)
        .then((records) => {
          if (isMounted) setRzpPayments(records);
        })
        .catch(() => {});
      const interval = setInterval(() => {
        fetchRazorpayPayments(10)
          .then((records) => {
            if (isMounted) setRzpPayments(records);
          })
          .catch(() => {});
      }, 3000);
      return () => {
        isMounted = false;
        clearInterval(interval);
      };
    }
  }, [gatewayMode]);

  const handleSwitchMode = (mode: 'simulated' | 'razorpay') => {
    setGatewayMode(mode);
    setStep('payee');
    setErrorMessage(null);
    setPayResult(null);
    setConfirmError(null);
    setOtpInput('');
    setRzpOutcome(null);
    setRzpError(null);
  };

  const handleUpiDecoded = (data: DecodedUpiData) => {
    if (gatewayMode === 'simulated') {
      setToAccount(data.pa);
      if (data.am) {
        setAmount(data.am);
      }
    } else {
      setRzpPayeeId(data.pa);
      if (data.am) {
        setRzpAmount(data.am);
      }
    }
    // Auto advance to amount if amount not in QR, or review if amount present
    if (data.am) {
      setStep('review');
    } else {
      setStep('amount');
    }
  };

  // Step 1 -> Step 2 validation
  const handleProceedToAmount = (e: React.FormEvent) => {
    e.preventDefault();
    const payee = gatewayMode === 'simulated' ? toAccount : rzpPayeeId;
    if (!payee.trim()) {
      setErrorMessage('Please select or enter a valid test payee ID.');
      return;
    }
    setErrorMessage(null);
    setRzpError(null);
    setStep('amount');
  };

  // Step 2 -> Step 3 validation
  const handleProceedToReview = (e: React.FormEvent) => {
    e.preventDefault();
    const currentAmt = gatewayMode === 'simulated' ? amount : rzpAmount;
    const num = parseFloat(currentAmt);
    if (isNaN(num) || num <= 0) {
      setErrorMessage('Please enter a valid amount greater than zero.');
      return;
    }
    setErrorMessage(null);
    setRzpError(null);
    setStep('review');
  };

  // Trigger actual simulated payment
  const executeSimulatedPayment = async () => {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    setStep('processing');
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
      setStep('result');
    } catch (err: any) {
      setErrorMessage(
        err.message ||
          "Can't reach the gateway service. Check that the backend is running, then retry."
      );
      setStep('review');
    }
  };

  // Trigger actual Razorpay test checkout
  const executeRazorpayPayment = async () => {
    const numAmount = parseFloat(rzpAmount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    setStep('processing');
    setRzpError(null);

    try {
      const startTime = performance.now();
      const orderRes = await createRazorpayOrder({
        customer_id: rzpCustomerId,
        payee_id: rzpPayeeId,
        amount_inr: numAmount,
      });
      const responseMs = performance.now() - startTime;

      if (orderRes.status === 'BLOCKED') {
        setRzpOutcome({
          status: 'BLOCKED',
          decision: orderRes.decision,
          risk_score: orderRes.risk_score,
          reasons: orderRes.reasons,
          message: orderRes.message || 'Payment blocked by fraud detection engine.',
          response_ms: responseMs,
        });
        loadRazorpayPaymentsLedger();
        setStep('result');
        return;
      }

      // Load checkout.js
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        throw new Error('Failed to load Razorpay Checkout script.');
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
            setStep('result');
          } catch (vErr: any) {
            setRzpError(vErr.message || 'Signature verification failed.');
            setStep('review');
          }
        },
        modal: {
          ondismiss: () => {
            setRzpError('Payment cancelled. Checkout window was closed.');
            loadRazorpayPaymentsLedger();
            setStep('review');
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
        const reasonMsg = failResp.error?.description || 'Payment declined by issuing bank.';
        setRzpError(`Payment failed: ${reasonMsg}`);
        loadRazorpayPaymentsLedger();
        setStep('review');
      });

      rzpInstance.open();
    } catch (err: any) {
      setRzpError(err.message || 'Failed to initiate Razorpay checkout.');
      setStep('review');
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
      setPayResult({
        ...payResult,
        status: conf.status as 'SUCCESS' | 'PENDING_VERIFICATION' | 'DECLINED' | 'FAILED',
        message: conf.message,
        sender_balance_after: conf.sender_balance_after,
      });
      loadSenderAccount(fromAccount);
      loadRecentPayments();
    } catch (err: any) {
      setConfirmError(err.message || 'OTP verification failed.');
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReset = () => {
    setStep('payee');
    setPayResult(null);
    setErrorMessage(null);
    setConfirmError(null);
    setOtpInput('');
    setRzpOutcome(null);
    setRzpError(null);
    if (gatewayMode === 'simulated') {
      loadSenderAccount(fromAccount);
    }
  };

  const currentPayee = gatewayMode === 'simulated' ? toAccount : rzpPayeeId;
  const currentAmount = gatewayMode === 'simulated' ? amount : rzpAmount;

  // Initials for avatar
  const getInitials = (vpa: string) => {
    const clean = vpa.split('@')[0] || vpa;
    return clean.slice(0, 2).toUpperCase();
  };

  const STEPS: StepItem[] = [
    { id: 'payee', label: 'Payee' },
    { id: 'amount', label: 'Amount' },
    { id: 'review', label: 'Review' },
    { id: 'result', label: 'Result' },
  ];

  const getStepIndex = () => {
    if (step === 'payee') return 0;
    if (step === 'amount') return 1;
    if (step === 'review' || step === 'processing') return 2;
    return 3;
  };

  return (
    <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] py-6 sm:py-8 px-4 flex justify-center items-start">
      <div className="w-full sm:max-w-[560px] space-y-4">
        {/* Main Payment Container */}
        <div className="bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] p-5 sm:p-6 shadow-sm">
          {/* Header & Mode Switch */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-[#E3E7EE]">
            <div className="flex items-center gap-2">
              <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5">
                <h1 className="text-[16px] font-semibold text-[#1B2433] whitespace-nowrap">Send money</h1>
              </div>
              <span className="text-[11px] font-mono px-1.5 py-0.5 bg-[#F4F5F7] border border-[#E3E7EE] rounded text-[#8A94A6] whitespace-nowrap">
                Test mode
              </span>
            </div>

            {razorpayConfig?.enabled ? (
              <div className="flex w-full sm:w-auto bg-[#F4F5F7] p-0.5 rounded-[6px] border border-[#E3E7EE]">
                <button
                  type="button"
                  onClick={() => handleSwitchMode('simulated')}
                  className={`flex-1 sm:flex-initial px-3 min-h-[44px] text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
                    gatewayMode === 'simulated'
                      ? 'bg-[#FFFFFF] text-[#1B2433] shadow-sm'
                      : 'text-[#8A94A6] hover:text-[#1B2433]'
                  }`}
                >
                  Simulated gateway
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchMode('razorpay')}
                  className={`flex-1 sm:flex-initial px-3 min-h-[44px] text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
                    gatewayMode === 'razorpay'
                      ? 'bg-[#FFFFFF] text-[#1F4FD8] shadow-sm'
                      : 'text-[#8A94A6] hover:text-[#1B2433]'
                  }`}
                >
                  Razorpay (test mode)
                </button>
              </div>
            ) : (
              <span className="self-start sm:self-auto text-[11px] font-medium text-[#8A94A6] bg-[#F4F5F7] border border-[#E3E7EE] px-2 py-0.5 rounded-[4px] whitespace-nowrap">
                Simulated gateway
              </span>
            )}
          </div>

          {/* Stepper Component */}
          {step !== 'processing' && (
            <div className="mb-5 pb-3 border-b border-[#E3E7EE]">
              <Stepper steps={STEPS} currentStepIndex={getStepIndex()} />
            </div>
          )}

          {/* Razorpay Banner Info */}
          {gatewayMode === 'razorpay' && step !== 'result' && (
            <div className="mb-4 p-3 bg-[#EEF3FD] border border-[#1F4FD8]/20 rounded-[6px] text-[12px] text-[#1B2433] leading-normal">
              <span className="font-semibold text-[#1F4FD8]">Test mode:</span> no real money is moved.
              <div className="mt-1 text-[#8A94A6]">
                • <strong className="text-[#1B2433]">Payee:</strong> use <code className="font-mono bg-[#FFFFFF] px-1 py-0.5 rounded border border-[#E3E7EE] text-[#1B2433]">success@razorpay</code> or <code className="font-mono bg-[#FFFFFF] px-1 py-0.5 rounded border border-[#E3E7EE] text-[#1B2433]">failure@razorpay</code>.<br />
                • <strong className="text-[#1B2433]">Cards:</strong> enter <code className="font-mono bg-[#FFFFFF] px-1 py-0.5 rounded border border-[#E3E7EE] text-[#1B2433]">4111 1111 1111 1111</code> (any expiry / CVV).
              </div>
            </div>
          )}

          {/* Error Message */}
          {(errorMessage || rzpError) && (
            <div className="mb-4 p-3 bg-[#C53030]/10 border border-[#C53030]/20 rounded-[6px] text-[13px] text-[#C53030]">
              {errorMessage || rzpError}
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 1: PICK PAYEE */}
          {/* ========================================================================= */}
          {step === 'payee' && (
            <div className="space-y-4">
              {/* QR Scanner Panel */}
              <QrScannerPanel
                onUpiDecoded={handleUpiDecoded}
                initialTab={showAutoScan ? 'camera' : 'upload'}
              />

              <form onSubmit={handleProceedToAmount} className="space-y-4">
                {/* Sender Account Info (in simulated mode) */}
                {gatewayMode === 'simulated' && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label htmlFor="from-account" className="text-[12px] font-medium text-[#8A94A6]">
                        From account
                      </label>
                      {isAccountLoading ? (
                        <span className="text-[11px] text-[#8A94A6]">Checking balance...</span>
                      ) : senderAccount ? (
                        <span className="text-[12px] text-[#1B2433]">
                          Balance: <span className="font-mono font-semibold tabular-nums">₹{senderAccount.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-[#8A94A6]">Seeded: ACC_0000 - ACC_0499</span>
                      )}
                    </div>
                    <input
                      id="from-account"
                      type="text"
                      required
                      placeholder="e.g. ACC_0010"
                      value={fromAccount}
                      onChange={(e) => setFromAccount(e.target.value.toUpperCase())}
                      className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] font-mono text-[13px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
                    />
                  </div>
                )}

                {/* Payee Selection with quick buttons */}
                <div>
                  <label htmlFor="payee-id" className="block text-[12px] font-medium text-[#8A94A6] mb-1">
                    Payee address (UPI ID / Account)
                  </label>
                  <input
                    id="payee-id"
                    type="text"
                    required
                    placeholder="e.g. success@razorpay"
                    value={gatewayMode === 'simulated' ? toAccount : rzpPayeeId}
                    onChange={(e) => {
                      if (gatewayMode === 'simulated') {
                        setToAccount(e.target.value);
                      } else {
                        setRzpPayeeId(e.target.value);
                      }
                    }}
                    className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] font-mono text-[13px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
                  />

                  {/* Quick Test Payees */}
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[11px] text-[#8A94A6]">Test payees:</span>
                    <button
                      type="button"
                      onClick={() => {
                        if (gatewayMode === 'simulated') setToAccount('success@razorpay');
                        else setRzpPayeeId('success@razorpay');
                      }}
                      className="px-2 py-0.5 text-[11px] font-mono bg-[#F4F5F7] border border-[#E3E7EE] hover:border-[#1F4FD8] rounded text-[#1B2433]"
                    >
                      success@razorpay
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (gatewayMode === 'simulated') setToAccount('failure@razorpay');
                        else setRzpPayeeId('failure@razorpay');
                      }}
                      className="px-2 py-0.5 text-[11px] font-mono bg-[#F4F5F7] border border-[#E3E7EE] hover:border-[#C53030] rounded text-[#1B2433]"
                    >
                      failure@razorpay
                    </button>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
                  >
                    Continue to amount
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 2: ENTER AMOUNT */}
          {/* ========================================================================= */}
          {step === 'amount' && (
            <form onSubmit={handleProceedToReview} className="space-y-5">
              {/* Payee context pill */}
              <div className="flex items-center justify-between p-3 bg-[#F4F5F7] rounded-[6px] border border-[#E3E7EE]">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-[#1F4FD8] text-[#FFFFFF] flex items-center justify-center font-mono text-[11px] font-semibold">
                    {getInitials(currentPayee)}
                  </div>
                  <div>
                    <div className="text-[11px] text-[#8A94A6]">Paying to</div>
                    <div className="font-mono text-[12px] font-medium text-[#1B2433]">{currentPayee}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setStep('payee')}
                  className="text-[12px] text-[#1F4FD8] hover:underline"
                >
                  Change
                </button>
              </div>

              {/* Large Amount Input */}
              <div className="text-center py-3">
                <div className="text-[12px] text-[#8A94A6] mb-1 font-medium">Enter transfer amount</div>
                <div className="flex items-center justify-center">
                  <span className="text-[28px] font-medium text-[#8A94A6] mr-1">₹</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    autoFocus
                    placeholder="0"
                    value={gatewayMode === 'simulated' ? amount : rzpAmount}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9.]/g, '');
                      if (gatewayMode === 'simulated') setAmount(val);
                      else setRzpAmount(val);
                    }}
                    className="w-48 text-[32px] font-semibold font-mono text-center text-[#1B2433] focus:outline-none border-b-2 border-[#1F4FD8] bg-transparent"
                  />
                </div>
              </div>

              {/* On-screen Numeric Keypad for Mobile (min 44px touch targets) */}
              <div className="bg-[#F4F5F7]/60 border border-[#E3E7EE] rounded-[8px] p-2 space-y-1.5">
                <div className="grid grid-cols-3 gap-1.5">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <button
                      key={digit}
                      type="button"
                      onClick={() => {
                        const cur = gatewayMode === 'simulated' ? amount : rzpAmount;
                        const next = cur === '0' || !cur ? digit : cur + digit;
                        if (gatewayMode === 'simulated') setAmount(next);
                        else setRzpAmount(next);
                      }}
                      className="min-h-[44px] bg-[#FFFFFF] hover:bg-[#EEF3FD] active:bg-[#E3E7EE] border border-[#E3E7EE] rounded-[6px] text-[16px] font-mono font-medium text-[#1B2433] transition-colors"
                    >
                      {digit}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const cur = gatewayMode === 'simulated' ? amount : rzpAmount;
                      if (!cur.includes('.')) {
                        const next = cur ? cur + '.' : '0.';
                        if (gatewayMode === 'simulated') setAmount(next);
                        else setRzpAmount(next);
                      }
                    }}
                    className="min-h-[44px] bg-[#FFFFFF] hover:bg-[#EEF3FD] active:bg-[#E3E7EE] border border-[#E3E7EE] rounded-[6px] text-[16px] font-mono font-medium text-[#1B2433] transition-colors"
                  >
                    .
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const cur = gatewayMode === 'simulated' ? amount : rzpAmount;
                      const next = cur === '0' || !cur ? '0' : cur + '0';
                      if (gatewayMode === 'simulated') setAmount(next);
                      else setRzpAmount(next);
                    }}
                    className="min-h-[44px] bg-[#FFFFFF] hover:bg-[#EEF3FD] active:bg-[#E3E7EE] border border-[#E3E7EE] rounded-[6px] text-[16px] font-mono font-medium text-[#1B2433] transition-colors"
                  >
                    0
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const cur = gatewayMode === 'simulated' ? amount : rzpAmount;
                      const next = cur.slice(0, -1);
                      if (gatewayMode === 'simulated') setAmount(next);
                      else setRzpAmount(next);
                    }}
                    className="min-h-[44px] bg-[#FFFFFF] hover:bg-[#EEF3FD] active:bg-[#E3E7EE] border border-[#E3E7EE] rounded-[6px] text-[14px] font-medium text-[#8A94A6] hover:text-[#1B2433] transition-colors"
                  >
                    ⌫
                  </button>
                </div>
              </div>

              {/* Quick Amount Chips */}
              <div className="grid grid-cols-4 gap-2">
                {['500', '1000', '2500', '5000'].map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => {
                      if (gatewayMode === 'simulated') setAmount(chip);
                      else setRzpAmount(chip);
                    }}
                    className="py-2 min-h-[44px] text-[12px] font-mono font-medium bg-[#FFFFFF] border border-[#E3E7EE] hover:border-[#1F4FD8] rounded-[6px] text-[#1B2433] transition-colors"
                  >
                    ₹{chip}
                  </button>
                ))}
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep('payee')}
                  className="w-1/3 min-h-[44px] py-2 px-3 border border-[#E3E7EE] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7]"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="flex-1 min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
                >
                  Review transfer
                </button>
              </div>
            </form>
          )}

          {/* ========================================================================= */}
          {/* STEP 3: REVIEW & CONFIRM */}
          {/* ========================================================================= */}
          {step === 'review' && (
            <div className="space-y-4">
              {/* Payee Card with Avatar */}
              <div className="p-4 bg-[#F4F5F7]/70 border border-[#E3E7EE] rounded-[6px] text-center space-y-2">
                <div className="w-12 h-12 mx-auto rounded-full bg-[#1F4FD8] text-[#FFFFFF] flex items-center justify-center font-mono text-[16px] font-semibold shadow-sm">
                  {getInitials(currentPayee)}
                </div>
                <div className="text-[12px] text-[#8A94A6]">Transfer to</div>
                <div className="font-mono text-[14px] font-semibold text-[#1B2433] select-all">
                  {currentPayee}
                </div>
                <div className="text-[28px] font-semibold font-mono text-[#1B2433] pt-1">
                  ₹{parseFloat(currentAmount || '0').toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </div>
              </div>

              {/* Review Metadata Table */}
              <div className="border border-[#E3E7EE] rounded-[6px] divide-y divide-[#E3E7EE] text-[12px]">
                <div className="p-3 flex justify-between">
                  <span className="text-[#8A94A6]">Gateway mode</span>
                  <span className="font-medium text-[#1B2433]">
                    {gatewayMode === 'simulated' ? 'Simulated gateway' : 'Razorpay (test mode)'}
                  </span>
                </div>
                {gatewayMode === 'simulated' && (
                  <div className="p-3 flex justify-between">
                    <span className="text-[#8A94A6]">From account</span>
                    <span className="font-mono text-[#1B2433]">{fromAccount}</span>
                  </div>
                )}
                <div className="p-3 flex justify-between items-center">
                  <span className="text-[#8A94A6]">Fraud checkpoint</span>
                  <span className="font-medium text-[#1F4FD8]">Real-time ML & graph scorer</span>
                </div>
              </div>

              {/* Notice */}
              <div className="text-[11px] text-[#8A94A6] text-center">
                Demo test mode: fund movement and fraud checks are evaluated safely.
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep('amount')}
                  className="w-1/3 min-h-[44px] py-2 px-3 border border-[#E3E7EE] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7]"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={gatewayMode === 'simulated' ? executeSimulatedPayment : executeRazorpayPayment}
                  className="flex-1 min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
                >
                  Pay ₹{parseFloat(currentAmount || '0').toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </button>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 4: PROCESSING (FRAUD EVALUATION) */}
          {/* ========================================================================= */}
          {step === 'processing' && (
            <div className="py-12 text-center space-y-4">
              <div className="inline-block w-8 h-8 border-3 border-[#1F4FD8] border-t-transparent rounded-full animate-spin" />
              <div className="text-[16px] font-medium text-[#1B2433]">
                Checking this payment for fraud
              </div>
              <p className="text-[12px] text-[#8A94A6] max-w-sm mx-auto leading-relaxed">
                Evaluating velocity, amount thresholds, and graph topology against risk checkpoint...
              </p>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 5: RESULT & OTP */}
          {/* ========================================================================= */}
          {step === 'result' && (
            <div className="space-y-4">
              {/* Simulated Gateway Result */}
              {gatewayMode === 'simulated' && payResult && (
                <div className="space-y-4">
                  <div
                    className={`p-4 bg-[#FFFFFF] border border-[#E3E7EE] border-l-4 rounded-[6px] ${
                      payResult.status === 'SUCCESS'
                        ? 'border-l-[#13805B]'
                        : payResult.status === 'PENDING_VERIFICATION'
                        ? 'border-l-[#B7791F]'
                        : 'border-l-[#C53030]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[16px] font-semibold text-[#1B2433]">
                        {payResult.status === 'SUCCESS'
                          ? 'Payment successful'
                          : payResult.status === 'PENDING_VERIFICATION'
                          ? 'Needs your confirmation'
                          : 'Payment declined by fraud check'}
                      </div>
                      <DecisionBadge decision={payResult.status === 'SUCCESS' ? 'ALLOW' : payResult.status === 'PENDING_VERIFICATION' ? 'REVIEW' : 'BLOCK'} />
                    </div>
                    <p className="text-[13px] text-[#1B2433] leading-normal">{payResult.message}</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#E3E7EE] text-[12px] text-[#8A94A6] font-mono tabular-nums">
                      <div>
                        Reference: <span className="text-[#1B2433] select-all">{payResult.reference_id || payResult.payment_id}</span>
                      </div>
                      <div>
                        Latency: <span className="font-semibold text-[#1B2433]">{payResult.total_ms.toFixed(1)} ms</span>
                      </div>
                      <div>
                        Risk score: <span className="font-semibold text-[#1B2433]">{payResult.risk_score}</span> / 100
                      </div>
                      <div>
                        Balance after:{' '}
                        <span className="font-semibold text-[#1B2433]">
                          ₹{payResult.sender_balance_after !== null && payResult.sender_balance_after !== undefined
                            ? payResult.sender_balance_after.toLocaleString('en-IN', { minimumFractionDigits: 2 })
                            : '—'}
                        </span>
                      </div>
                    </div>

                    {/* View Receipt Button */}
                    {(payResult.status === 'SUCCESS' || payResult.status === 'DECLINED') && payResult.reference_id && (
                      <div className="mt-3 pt-2 border-t border-[#E3E7EE] flex justify-end">
                        <button
                          type="button"
                          disabled={isReceiptLoading}
                          onClick={async () => {
                            if (!payResult.reference_id) return;
                            setIsReceiptLoading(true);
                            try {
                              const rcp = await fetchPaymentReceipt(payResult.reference_id);
                              setSelectedReceipt(rcp);
                            } catch (err: any) {
                              setErrorMessage(err.message || 'Receipt could not be loaded.');
                            } finally {
                              setIsReceiptLoading(false);
                            }
                          }}
                          className="px-3 py-1.5 text-[12px] font-medium text-[#1F4FD8] bg-[#EEF3FD] hover:bg-[#DCE7FB] rounded-[4px] transition-colors"
                        >
                          {isReceiptLoading ? 'Loading receipt...' : 'View payment receipt'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* OTP Input for PENDING_VERIFICATION */}
                  {payResult.status === 'PENDING_VERIFICATION' && (
                    <div className="p-4 bg-[#F4F5F7] border border-[#E3E7EE] rounded-[6px] space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-medium text-[#1B2433]">Demo OTP, not a bank PIN</span>
                        <span className="text-[12px] font-mono font-semibold text-[#1F4FD8]">
                          Demo code: {payResult.demo_otp}
                        </span>
                      </div>
                      <p className="text-[12px] text-[#8A94A6]">
                        Enter the demo verification code above to authorize fund movement.
                      </p>

                      {confirmError && (
                        <div className="p-2 bg-[#C53030]/10 border border-[#C53030]/20 rounded-[4px] text-[12px] text-[#C53030]">
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
                          className="flex-1 px-3 py-1.5 bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] font-mono text-[14px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
                        />
                        <button
                          type="submit"
                          disabled={isConfirming}
                          className="px-4 py-1.5 bg-[#1F4FD8] text-[#FFFFFF] text-[13px] font-medium rounded-[6px] hover:bg-[#183EB0] disabled:opacity-50 transition-colors whitespace-nowrap min-h-[44px]"
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
                      <p className="text-[12px] text-[#8A94A6]">
                        No fraud triggers detected. Passed baseline checks.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {payResult.reasons.map((r, i) => (
                          <div
                            key={i}
                            className="p-2.5 bg-[#F4F5F7] border border-[#E3E7EE] rounded-[4px] text-[12px]"
                          >
                            <div className="font-medium text-[#1B2433]">{r.detail}</div>
                            <div className="text-[#8A94A6] text-[11px] mt-0.5">
                              {r.rule} (weight {r.weight})
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Razorpay Result */}
              {gatewayMode === 'razorpay' && rzpOutcome && (
                <div className="space-y-4">
                  <div
                    className={`p-4 bg-[#FFFFFF] border border-[#E3E7EE] border-l-4 rounded-[6px] ${
                      rzpOutcome.status === 'VERIFIED'
                        ? 'border-l-[#13805B]'
                        : rzpOutcome.status === 'BLOCKED'
                        ? 'border-l-[#C53030]'
                        : 'border-l-[#8A94A6]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[16px] font-semibold text-[#1B2433]">
                        {rzpOutcome.status === 'VERIFIED'
                          ? 'Payment successful'
                          : rzpOutcome.status === 'BLOCKED'
                          ? 'Payment declined by fraud check'
                          : 'Payment failed'}
                      </div>
                      <DecisionBadge decision={rzpOutcome.decision} score={rzpOutcome.risk_score} />
                    </div>
                    <p className="text-[13px] text-[#1B2433] leading-normal">{rzpOutcome.message}</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3 pt-3 border-t border-[#E3E7EE] text-[12px] text-[#8A94A6] font-mono tabular-nums">
                      {rzpOutcome.order_id && (
                        <div className="break-all" title={rzpOutcome.order_id}>
                          Order: <span className="text-[#1B2433]">{rzpOutcome.order_id}</span>
                        </div>
                      )}
                      {rzpOutcome.payment_id && (
                        <div className="break-all" title={rzpOutcome.payment_id}>
                          Payment: <span className="text-[#1B2433]">{rzpOutcome.payment_id}</span>
                        </div>
                      )}
                      {rzpOutcome.response_ms && (
                        <div>
                          Response time:{' '}
                          <span className="font-semibold text-[#1B2433]">
                            {rzpOutcome.response_ms.toFixed(1)} ms
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Evaluated reasons */}
                  <div>
                    <h2 className="text-[13px] font-medium text-[#1B2433] mb-2">Evaluated reasons</h2>
                    {rzpOutcome.reasons.length === 0 ? (
                      <p className="text-[12px] text-[#8A94A6]">
                        No fraud triggers detected. Passed baseline checks.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {rzpOutcome.reasons.map((r, i) => (
                          <div
                            key={i}
                            className="p-2.5 bg-[#F4F5F7] border border-[#E3E7EE] rounded-[4px] text-[12px]"
                          >
                            <div className="font-medium text-[#1B2433]">{r.detail}</div>
                            <div className="text-[#8A94A6] text-[11px] mt-0.5">
                              {r.rule} (weight {r.weight})
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Navigation Actions */}
              <div className="pt-2 flex gap-2">
                {(onBackToPayHome || onBackToDashboard) && (
                  <button
                    type="button"
                    onClick={onBackToPayHome || onBackToDashboard}
                    className="w-1/2 min-h-[44px] py-2 px-3 border border-[#E3E7EE] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
                  >
                    {onBackToPayHome ? '← Back' : 'Back to dashboard'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex-1 min-h-[44px] py-2 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
                >
                  New payment
                </button>
              </div>
            </div>
          )}
        </div>

        {/* --- RECENT PAYMENTS LEDGER --- */}
        <div className="bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] p-5">
          <div className="flex items-center justify-between mb-3 border-b border-[#E3E7EE] pb-2">
            <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5">
              <h2 className="text-[14px] font-semibold text-[#1B2433]">
                {gatewayMode === 'simulated' ? 'Recent simulated payments' : 'Razorpay payments'}
              </h2>
            </div>
            <span className="text-[11px] text-[#8A94A6] font-mono tabular-nums">
              {gatewayMode === 'simulated' ? recentPayments.length : rzpPayments.length} recorded
            </span>
          </div>

          {gatewayMode === 'simulated' ? (
            recentPayments.length === 0 ? (
              <p className="text-[12px] text-[#8A94A6] text-center py-4">
                No gateway transactions yet. Submit a payment above.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#E3E7EE] text-[#8A94A6]">
                      <th className="py-2 pr-2 font-normal">From</th>
                      <th className="py-2 px-2 font-normal">To</th>
                      <th className="py-2 px-2 font-normal text-right">Amount</th>
                      <th className="py-2 px-2 font-normal text-center">Status</th>
                      <th className="py-2 pl-2 font-normal text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E3E7EE]">
                    {recentPayments.map((p, idx) => {
                      let badgeClass = 'bg-[#13805B]/10 text-[#13805B]';
                      let statusLabel = 'Success';

                      if (p.status === 'PENDING_VERIFICATION') {
                        badgeClass = 'bg-[#B7791F]/10 text-[#B7791F]';
                        statusLabel = 'Pending';
                      } else if (p.status === 'DECLINED') {
                        badgeClass = 'bg-[#C53030]/10 text-[#C53030]';
                        statusLabel = 'Declined';
                      } else if (p.status === 'FAILED') {
                        badgeClass = 'bg-[#8A94A6]/10 text-[#8A94A6]';
                        statusLabel = 'Failed';
                      }

                      const zebra = idx % 2 === 1 ? 'bg-[#F4F5F7]/30' : 'bg-[#FFFFFF]';
                      return (
                        <tr key={p.payment_id} className={`${zebra} hover:bg-[#EEF3FD]/60 transition-colors`}>
                          <td className="py-2 pr-2 font-mono text-[#1B2433]">{p.from_account}</td>
                          <td className="py-2 px-2 font-mono text-[#1B2433]">{p.to_account}</td>
                          <td className="py-2 px-2 text-right font-medium font-mono tabular-nums text-[#1B2433]">
                            ₹{p.amount.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badgeClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td className="py-2 pl-2 text-right">
                            {p.reference_id ? (
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    const rcp = await fetchPaymentReceipt(p.reference_id!);
                                    setSelectedReceipt(rcp);
                                  } catch (err: any) {
                                    setErrorMessage(err.message || 'Receipt not available.');
                                  }
                                }}
                                className="text-[11px] text-[#1F4FD8] hover:underline whitespace-nowrap"
                              >
                                Receipt
                              </button>
                            ) : (
                              <span className="text-[#8A94A6] text-[11px]">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : (
            rzpPayments.length === 0 ? (
              <p className="text-[12px] text-[#8A94A6] text-center py-4">
                No Razorpay transactions recorded yet. Initiate a checkout above.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#E3E7EE] text-[#8A94A6]">
                      <th className="py-2 pr-2 font-normal">Order ID</th>
                      <th className="py-2 px-2 font-normal text-right">Amount</th>
                      <th className="py-2 px-2 font-normal text-center">Decision</th>
                      <th className="py-2 pl-2 font-normal text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E3E7EE]">
                    {rzpPayments.map((p, idx) => {
                      let badgeClass = 'bg-[#13805B]/10 text-[#13805B]';
                      let statusLabel: string = p.status;

                      if (p.status === 'VERIFIED' || p.status === 'CAPTURED') {
                        badgeClass = 'bg-[#13805B]/10 text-[#13805B]';
                        statusLabel = 'Verified';
                      } else if (p.status === 'ORDER_CREATED') {
                        badgeClass = 'bg-[#1F4FD8]/10 text-[#1F4FD8]';
                        statusLabel = 'Created';
                      } else if (p.status === 'BLOCKED' || p.status === 'TAMPERED' || p.status === 'FAILED') {
                        badgeClass = 'bg-[#C53030]/10 text-[#C53030]';
                        statusLabel = p.status === 'BLOCKED' ? 'Blocked' : p.status === 'TAMPERED' ? 'Tampered' : 'Failed';
                      }

                      const zebra = idx % 2 === 1 ? 'bg-[#F4F5F7]/30' : 'bg-[#FFFFFF]';
                      return (
                        <tr key={p.order_id} className={`${zebra} hover:bg-[#EEF3FD]/60 transition-colors`}>
                          <td className="py-2 pr-2 font-mono text-[11px] text-[#1B2433] max-w-[140px] truncate" title={p.order_id}>
                            {p.order_id}
                          </td>
                          <td className="py-2 px-2 text-right font-medium font-mono tabular-nums text-[#1B2433]">
                            ₹{p.amount.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                          </td>
                          <td className="py-2 px-3 text-center">
                            <DecisionBadge decision={p.decision} score={p.risk_score} />
                          </td>
                          <td className="py-2 pl-2 text-right">
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
            )
          )}
        </div>

        {/* Structured Payment Receipt Modal */}
        <PaymentReceiptModal
          receipt={selectedReceipt}
          onClose={() => setSelectedReceipt(null)}
        />
      </div>
    </div>
  );
};
