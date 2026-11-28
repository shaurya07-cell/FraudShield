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

// Preset verified contacts to give authentic banking feel while using valid backend accounts
interface PresetContact {
  name: string;
  handle: string;
  accountId: string;
  avatarBg: string;
  role: string;
}

const PRESET_CONTACTS: PresetContact[] = [
  {
    name: 'Rohan Sharma',
    handle: 'rohan.sharma@upi',
    accountId: 'ACC_0015',
    avatarBg: 'bg-[#1F4FD8]',
    role: 'Frequent Payee',
  },
  {
    name: 'Priya Patel',
    handle: 'priya.patel@upi',
    accountId: 'ACC_0042',
    avatarBg: 'bg-[#13805B]',
    role: 'Vendor / Retail',
  },
  {
    name: 'Razorpay Merchant',
    handle: 'merchant@razorpay',
    accountId: 'success@razorpay',
    avatarBg: 'bg-[#6B4FD1]',
    role: 'Verified Merchant',
  },
  {
    name: 'Vikram Malhotra',
    handle: 'vikram.m@upi',
    accountId: 'ACC_0120',
    avatarBg: 'bg-[#B7791F]',
    role: 'Business Partner',
  },
];

export const SendMoneyView: React.FC<SendMoneyViewProps> = ({
  onBackToDashboard,
  onBackToPayHome,
  initialMode,
  autoScan,
  selfTransfer,
}) => {
  // Gateway mode: simulated (UPI / Bank transfer) or razorpay (Cards / NetBanking)
  const [gatewayMode, setGatewayMode] = useState<'simulated' | 'razorpay'>(initialMode || 'simulated');
  const [razorpayConfig, setRazorpayConfig] = useState<RazorpayConfig | null>(null);

  // Stepped flow state
  const [step, setStep] = useState<UpiStep>('payee');
  const [showQrScanner, setShowQrScanner] = useState<boolean>(autoScan ?? false);

  // Sender details
  const [fromAccount] = useState('ACC_0010');
  const [toAccount, setToAccount] = useState(selfTransfer ? 'ACC_0010' : 'success@razorpay');
  const [toDisplayName, setToDisplayName] = useState(selfTransfer ? 'Self Account' : 'Razorpay Merchant');
  const [amount, setAmount] = useState('1250');
  const [note, setNote] = useState('');
  const [senderAccount, setSenderAccount] = useState<GatewayAccount | null>(null);

  // Results & verification
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

  // Fetch sender balance
  const loadSenderAccount = useCallback(async (accId: string) => {
    if (!accId.trim()) {
      setSenderAccount(null);
      return;
    }
    try {
      const acc = await fetchGatewayAccount(accId);
      setSenderAccount(acc);
    } catch {
      setSenderAccount(null);
    }
  }, []);

  // Fetch recent payments
  const loadRecentPayments = useCallback(async () => {
    try {
      const records = await fetchGatewayPayments(10);
      setRecentPayments(records);
    } catch {
      // Silent error during poll
    }
  }, []);

  // Fetch Razorpay payments
  const loadRzpPayments = useCallback(async () => {
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
    } else {
      fetchRazorpayPayments(10)
        .then((records) => {
          if (isMounted) setRzpPayments(records);
        })
        .catch(() => {});
    }

    const interval = setInterval(() => {
      if (gatewayMode === 'simulated') {
        fetchGatewayPayments(10)
          .then((records) => {
            if (isMounted) setRecentPayments(records);
          })
          .catch(() => {});
      } else {
        fetchRazorpayPayments(10)
          .then((records) => {
            if (isMounted) setRzpPayments(records);
          })
          .catch(() => {});
      }
    }, 4000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [gatewayMode]);

  const handleSwitchMode = (mode: 'simulated' | 'razorpay') => {
    setGatewayMode(mode);
    setStep('payee');
    setErrorMessage(null);
    setRzpError(null);
  };

  const handleSelectContact = (contact: PresetContact) => {
    if (gatewayMode === 'simulated') {
      setToAccount(contact.accountId);
      setToDisplayName(contact.name);
    } else {
      setRzpPayeeId(contact.accountId);
      setToDisplayName(contact.name);
    }
    setErrorMessage(null);
  };

  const handleUpiDecoded = (data: DecodedUpiData) => {
    if (gatewayMode === 'simulated') {
      setToAccount(data.pa);
      setToDisplayName(data.pn || data.pa);
      if (data.am) {
        setAmount(data.am);
      }
    } else {
      setRzpPayeeId(data.pa);
      setToDisplayName(data.pn || data.pa);
      if (data.am) {
        setRzpAmount(data.am);
      }
    }
    setShowQrScanner(false);
    setErrorMessage(null);
    setStep('amount');
  };

  const handleProceedToAmount = (e: React.FormEvent) => {
    e.preventDefault();
    const payee = gatewayMode === 'simulated' ? toAccount : rzpPayeeId;
    if (!payee.trim()) {
      setErrorMessage('Please select or enter a valid recipient UPI ID or account.');
      return;
    }
    setErrorMessage(null);
    setStep('amount');
  };

  const handleProceedToReview = (e: React.FormEvent) => {
    e.preventDefault();
    const currentAmt = gatewayMode === 'simulated' ? amount : rzpAmount;
    const num = parseFloat(currentAmt);
    if (isNaN(num) || num <= 0) {
      setErrorMessage('Please enter an amount greater than ₹0.');
      return;
    }
    setErrorMessage(null);
    setStep('review');
  };

  // Trigger payment execution
  const executeSimulatedPayment = async () => {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    setStep('processing');
    setErrorMessage(null);

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
      setErrorMessage(err.message || 'Payment execution failed.');
      setStep('review');
    }
  };

  // Trigger Razorpay payment flow
  const executeRazorpayPayment = async () => {
    const numAmount = parseFloat(rzpAmount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    setStep('processing');
    setRzpError(null);

    try {
      const isLoaded = await loadRazorpayScript();
      if (!isLoaded) {
        throw new Error('Razorpay secure checkout could not be loaded. Check your internet connection.');
      }

      const orderData = await createRazorpayOrder({
        customer_id: rzpCustomerId,
        amount_inr: numAmount,
        payee_id: rzpPayeeId,
      });

      if (orderData.decision === 'BLOCK') {
        setRzpOutcome({
          status: 'BLOCKED',
          order_id: null,
          decision: 'BLOCK',
          risk_score: orderData.risk_score,
          reasons: orderData.reasons,
          message: orderData.message || 'Payment declined by fraud checkpoint.',
        });
        loadRzpPayments();
        setStep('result');
        return;
      }

      const options = {
        key: orderData.key_id,
        amount: orderData.amount,
        currency: 'INR',
        name: 'FraudShield Settlement',
        description: `Direct Transfer to ${toDisplayName || rzpPayeeId}`,
        order_id: orderData.order_id,
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          try {
            setStep('processing');
            const verifyStart = performance.now();
            const verifyRes = await verifyRazorpayPayment({
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            const totalMs = performance.now() - verifyStart;

            setRzpOutcome({
              status: verifyRes.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED',
              order_id: verifyRes.order_id,
              payment_id: verifyRes.payment_id,
              decision: orderData.decision,
              risk_score: orderData.risk_score,
              reasons: orderData.reasons,
              message: verifyRes.message || 'Payment authorized and verified.',
              response_ms: totalMs,
            });
            loadRzpPayments();
            setStep('result');
          } catch (vErr: any) {
            setRzpError(vErr.message || 'Payment verification failed.');
            setStep('review');
          }
        },
        prefill: {
          name: senderAccount?.name || 'Aarav Sharma',
          email: 'customer@fraudshield.internal',
          contact: '+919876543210',
        },
        theme: {
          color: '#1F4FD8',
        },
        modal: {
          ondismiss: () => {
            setStep('review');
          },
        },
      };

      const rzpInstance = new (window as any).Razorpay(options);
      rzpInstance.on('payment.failed', (failResp: any) => {
        setRzpOutcome({
          status: 'FAILED',
          order_id: orderData.order_id,
          payment_id: failResp.error?.metadata?.payment_id,
          decision: null,
          risk_score: 0,
          reasons: [],
          message: failResp.error?.description || 'Payment cancelled or failed at gateway.',
        });
        loadRzpPayments();
        setStep('result');
      });

      rzpInstance.open();
    } catch (err: any) {
      setRzpError(err.message || 'Failed to initiate secure checkout.');
      setStep('review');
    }
  };

  // Confirm OTP / Two-Factor Authentication
  const handleConfirmOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payResult || !payResult.payment_id) return;

    setIsConfirming(true);
    setConfirmError(null);

    try {
      const confirmRes = await confirmGatewayPayment(payResult.payment_id, otpInput);
      setPayResult({
        ...payResult,
        status: confirmRes.status as any,
        message: confirmRes.message,
        sender_balance_after: confirmRes.sender_balance_after,
      });
      loadSenderAccount(fromAccount);
      loadRecentPayments();
    } catch (err: any) {
      setConfirmError(err.message || 'Invalid security verification passcode.');
    } finally {
      setIsConfirming(false);
    }
  };

  const handleReset = () => {
    setStep('payee');
    setPayResult(null);
    setRzpOutcome(null);
    setOtpInput('');
    setErrorMessage(null);
    setRzpError(null);
    if (gatewayMode === 'simulated') {
      loadSenderAccount(fromAccount);
    }
  };

  const currentPayee = gatewayMode === 'simulated' ? toAccount : rzpPayeeId;
  const currentAmount = gatewayMode === 'simulated' ? amount : rzpAmount;

  const getInitials = (text: string) => {
    const clean = text.split('@')[0] || text;
    return clean.slice(0, 2).toUpperCase();
  };

  const STEPS: StepItem[] = [
    { id: 'payee', label: 'Recipient' },
    { id: 'amount', label: 'Amount' },
    { id: 'review', label: 'Authorize' },
    { id: 'result', label: 'Confirmation' },
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
        {/* Main Bank Card Container */}
        <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[10px] p-5 sm:p-6 shadow-sm">
          {/* Header & Method Switch */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-[#E3E7EE]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-full bg-[#1F4FD8]/10 text-[#1F4FD8] flex items-center justify-center">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-[16px] font-semibold text-[#1B2433]">Send Money</h1>
                <div className="flex items-center gap-1.5 text-[11px] text-[#13805B] font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#13805B]" />
                  <span>256-bit Encrypted · Real-Time Network</span>
                </div>
              </div>
            </div>

            {/* Payment Method Switcher */}
            {razorpayConfig?.enabled ? (
              <div className="flex w-full sm:w-auto bg-[#F4F5F7] p-0.5 rounded-[6px] border border-[#DCE0E7]">
                <button
                  type="button"
                  onClick={() => handleSwitchMode('simulated')}
                  className={`flex-1 sm:flex-initial px-3 min-h-[38px] text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
                    gatewayMode === 'simulated'
                      ? 'bg-[#FFFFFF] text-[#1B2433] shadow-sm font-semibold'
                      : 'text-[#5B6575] hover:text-[#1B2433]'
                  }`}
                >
                  Direct UPI / Bank
                </button>
                <button
                  type="button"
                  onClick={() => handleSwitchMode('razorpay')}
                  className={`flex-1 sm:flex-initial px-3 min-h-[38px] text-[12px] font-medium rounded-[4px] whitespace-nowrap transition-colors ${
                    gatewayMode === 'razorpay'
                      ? 'bg-[#FFFFFF] text-[#1F4FD8] shadow-sm font-semibold'
                      : 'text-[#5B6575] hover:text-[#1B2433]'
                  }`}
                >
                  Card / NetBanking
                </button>
              </div>
            ) : (
              <span className="self-start sm:self-auto text-[11px] font-medium text-[#13805B] bg-[#13805B]/10 border border-[#13805B]/20 px-2.5 py-1 rounded-[4px] whitespace-nowrap">
                Direct Bank Transfer
              </span>
            )}
          </div>

          {/* Stepper Component */}
          {step !== 'processing' && (
            <div className="mb-5 pb-3 border-b border-[#E3E7EE]">
              <Stepper steps={STEPS} currentStepIndex={getStepIndex()} />
            </div>
          )}

          {/* Error Banner */}
          {(errorMessage || rzpError) && (
            <div className="mb-4 p-3 bg-[#C0362C]/10 border border-[#C0362C]/20 rounded-[6px] text-[13px] text-[#C0362C] flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{errorMessage || rzpError}</span>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 1: PICK RECIPIENT */}
          {/* ========================================================================= */}
          {step === 'payee' && (
            <div className="space-y-5">
              {/* Sender Account Card */}
              <div className="p-3.5 bg-gradient-to-r from-[#17202E] to-[#1F2D42] rounded-[8px] text-white shadow-sm">
                <div className="flex items-center justify-between text-[11px] text-white/70">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#1E8E5A]" />
                    <span className="font-medium text-white/90">FraudShield Federal Bank</span>
                  </div>
                  <span className="font-mono">Primary Savings</span>
                </div>
                <div className="mt-2.5 flex items-baseline justify-between">
                  <div>
                    <div className="text-[10px] text-white/60 tracking-wider">AVAILABLE BALANCE</div>
                    <div className="text-[20px] font-semibold font-mono tabular-nums text-white">
                      ₹{senderAccount ? senderAccount.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '1,84,250.00'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] font-medium text-white/90">{senderAccount?.name || 'Aarav Sharma'}</div>
                    <div className="text-[11px] font-mono text-white/60">•••• {fromAccount.slice(-4)}</div>
                  </div>
                </div>
              </div>

              {/* QR Scanner Expandable Header */}
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-semibold text-[#1B2433]">Recipient details</div>
                <button
                  type="button"
                  onClick={() => setShowQrScanner(!showQrScanner)}
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#1F4FD8] hover:underline"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  <span>{showQrScanner ? 'Hide QR scanner' : 'Scan UPI QR code'}</span>
                </button>
              </div>

              {/* QR Scanner Panel when open */}
              {showQrScanner && (
                <div className="rounded-[8px] border border-[#DCE0E7] overflow-hidden">
                  <QrScannerPanel
                    onUpiDecoded={handleUpiDecoded}
                    initialTab={autoScan ? 'camera' : 'upload'}
                  />
                </div>
              )}

              {/* Form Input for Manual Address */}
              <form onSubmit={handleProceedToAmount} className="space-y-4">
                <div>
                  <label htmlFor="payee-id" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                    Enter UPI ID, Phone Number or Account ID
                  </label>
                  <div className="relative">
                    <input
                      id="payee-id"
                      type="text"
                      required
                      placeholder="e.g. rohan.sharma@upi or ACC_0015"
                      value={gatewayMode === 'simulated' ? toAccount : rzpPayeeId}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (gatewayMode === 'simulated') {
                          setToAccount(val);
                          setToDisplayName(val);
                        } else {
                          setRzpPayeeId(val);
                          setToDisplayName(val);
                        }
                      }}
                      className="w-full pl-3 pr-10 py-2.5 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[13px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8] transition-colors"
                    />
                    <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[#5B6575]">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* Verified Recent Contacts List */}
                <div>
                  <div className="text-[12px] font-medium text-[#5B6575] mb-2 flex items-center justify-between">
                    <span>Frequent & Verified Recipients</span>
                    <span className="text-[11px] text-[#1E8E5A] font-medium">● Instant Settlement</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {PRESET_CONTACTS.map((contact) => {
                      const isSelected = (gatewayMode === 'simulated' ? toAccount : rzpPayeeId) === contact.accountId;
                      return (
                        <button
                          key={contact.accountId}
                          type="button"
                          onClick={() => handleSelectContact(contact)}
                          className={`p-2.5 rounded-[6px] border text-left flex items-center gap-3 transition-all ${
                            isSelected
                              ? 'border-[#1F4FD8] bg-[#EEF3FD] shadow-xs'
                              : 'border-[#DCE0E7] bg-[#FFFFFF] hover:border-[#1F4FD8]/40 hover:bg-[#F4F5F7]'
                          }`}
                        >
                          <div className={`w-9 h-9 rounded-full text-white ${contact.avatarBg} flex items-center justify-center font-mono text-[12px] font-semibold flex-shrink-0`}>
                            {getInitials(contact.name)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-semibold text-[#1B2433] truncate flex items-center gap-1">
                              <span>{contact.name}</span>
                              <svg className="w-3.5 h-3.5 text-[#1E8E5A] flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            </div>
                            <div className="text-[11px] font-mono text-[#5B6575] truncate">{contact.handle}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors flex items-center justify-center gap-2"
                  >
                    <span>Proceed to Enter Amount</span>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
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
              <div className="flex items-center justify-between p-3 bg-[#F4F5F7] rounded-[8px] border border-[#DCE0E7]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-[#1F4FD8] text-[#FFFFFF] flex items-center justify-center font-mono text-[12px] font-semibold">
                    {getInitials(toDisplayName || currentPayee)}
                  </div>
                  <div>
                    <div className="text-[11px] text-[#5B6575]">Transferring to</div>
                    <div className="text-[13px] font-semibold text-[#1B2433]">{toDisplayName || currentPayee}</div>
                    <div className="text-[11px] font-mono text-[#5B6575]">{currentPayee}</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setStep('payee')}
                  className="text-[12px] font-medium text-[#1F4FD8] hover:underline"
                >
                  Change
                </button>
              </div>

              {/* Large Amount Input */}
              <div className="text-center py-4 bg-[#FFFFFF] rounded-[8px] border border-[#DCE0E7] p-4">
                <div className="text-[12px] text-[#5B6575] mb-2 font-medium">Transfer Amount</div>
                <div className="flex items-center justify-center">
                  <span className="text-[32px] font-medium text-[#5B6575] mr-1">₹</span>
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
                    className="w-56 text-[36px] font-bold font-mono text-center text-[#1B2433] focus:outline-none border-b-2 border-[#1F4FD8] bg-transparent"
                  />
                </div>
                <div className="mt-2 text-[11px] text-[#5B6575]">
                  Zero processing fees · Immediate RTGS/UPI settlement
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
                    className="py-2 min-h-[40px] text-[12px] font-mono font-medium bg-[#FFFFFF] border border-[#DCE0E7] hover:border-[#1F4FD8] hover:bg-[#EEF3FD] rounded-[6px] text-[#1B2433] transition-colors"
                  >
                    +₹{chip}
                  </button>
                ))}
              </div>

              {/* Optional Transfer Note */}
              <div>
                <label htmlFor="transfer-note" className="block text-[12px] font-medium text-[#5B6575] mb-1">
                  Remark / Note (Optional)
                </label>
                <input
                  id="transfer-note"
                  type="text"
                  placeholder="e.g. Invoice payment, groceries, dinner"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="w-full px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] text-[13px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
                />
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep('payee')}
                  className="w-1/3 min-h-[44px] py-2 px-3 border border-[#DCE0E7] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7]"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="flex-1 min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors flex items-center justify-center gap-1.5"
                >
                  <span>Review Transfer</span>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </form>
          )}

          {/* ========================================================================= */}
          {/* STEP 3: REVIEW & AUTHORIZE */}
          {/* ========================================================================= */}
          {step === 'review' && (
            <div className="space-y-4">
              {/* Payee Card with Avatar */}
              <div className="p-4 bg-gradient-to-b from-[#FFFFFF] to-[#F4F5F7] border border-[#DCE0E7] rounded-[8px] text-center space-y-2">
                <div className="w-12 h-12 mx-auto rounded-full bg-[#1F4FD8] text-[#FFFFFF] flex items-center justify-center font-mono text-[16px] font-semibold shadow-xs">
                  {getInitials(toDisplayName || currentPayee)}
                </div>
                <div className="text-[12px] text-[#5B6575]">Authorizing payment to</div>
                <div className="text-[16px] font-semibold text-[#1B2433]">
                  {toDisplayName || currentPayee}
                </div>
                <div className="font-mono text-[12px] text-[#5B6575]">
                  {currentPayee}
                </div>
                <div className="text-[30px] font-bold font-mono text-[#1B2433] pt-1">
                  ₹{parseFloat(currentAmount || '0').toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </div>
              </div>

              {/* Review Breakdown Table */}
              <div className="border border-[#DCE0E7] rounded-[8px] divide-y divide-[#E3E7EE] text-[12px] bg-[#FFFFFF]">
                <div className="p-3 flex justify-between items-center">
                  <span className="text-[#5B6575]">Debited from</span>
                  <span className="font-medium text-[#1B2433] flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-[#1E8E5A]" />
                    <span>FraudShield Primary (•••• {fromAccount.slice(-4)})</span>
                  </span>
                </div>
                <div className="p-3 flex justify-between items-center">
                  <span className="text-[#5B6575]">Settlement Rail</span>
                  <span className="font-medium text-[#1B2433]">
                    {gatewayMode === 'simulated' ? 'Instant UPI Real-Time Rail' : 'Razorpay Secure Gateway'}
                  </span>
                </div>
                <div className="p-3 flex justify-between items-center">
                  <span className="text-[#5B6575]">Transfer Fee</span>
                  <span className="font-medium text-[#1E8E5A]">₹0.00 (Zero Fee)</span>
                </div>
                <div className="p-3 flex justify-between items-center">
                  <span className="text-[#5B6575]">Security Checkpoint</span>
                  <span className="font-medium text-[#1F4FD8] flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span>ML Ensemble + Graph AI</span>
                  </span>
                </div>
              </div>

              {/* Security Statement */}
              <div className="flex items-center gap-2 p-3 bg-[#EEF3FD] rounded-[6px] border border-[#1F4FD8]/20 text-[11px] text-[#1B2433]">
                <svg className="w-4 h-4 text-[#1F4FD8] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span>Protected by FraudShield AI real-time risk engine. Every transaction is scored in &lt;50ms.</span>
              </div>

              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setStep('amount')}
                  className="w-1/3 min-h-[44px] py-2 px-3 border border-[#DCE0E7] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7]"
                >
                  Modify
                </button>
                <button
                  type="button"
                  onClick={gatewayMode === 'simulated' ? executeSimulatedPayment : executeRazorpayPayment}
                  className="flex-1 min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors flex items-center justify-center gap-2 shadow-xs"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span>Authorize & Pay ₹{parseFloat(currentAmount || '0').toLocaleString('en-IN', { minimumFractionDigits: 0 })}</span>
                </button>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 4: PROCESSING */}
          {/* ========================================================================= */}
          {step === 'processing' && (
            <div className="py-12 text-center space-y-4">
              <div className="inline-block w-9 h-9 border-3 border-[#1F4FD8] border-t-transparent rounded-full animate-spin" />
              <div className="text-[16px] font-semibold text-[#1B2433]">
                Processing Transfer Safely
              </div>
              <p className="text-[12px] text-[#5B6575] max-w-sm mx-auto leading-relaxed">
                Evaluating velocity markers, collusion rings, and counterparty graph topology in real time...
              </p>
            </div>
          )}

          {/* ========================================================================= */}
          {/* STEP 5: CONFIRMATION & TWO-FACTOR AUTH */}
          {/* ========================================================================= */}
          {step === 'result' && (
            <div className="space-y-4">
              {/* Simulated Gateway Result */}
              {gatewayMode === 'simulated' && payResult && (
                <div className="space-y-4">
                  <div
                    className={`p-5 bg-[#FFFFFF] border rounded-[8px] shadow-xs ${
                      payResult.status === 'SUCCESS'
                        ? 'border-[#1E8E5A]/30 border-t-4 border-t-[#1E8E5A]'
                        : payResult.status === 'PENDING_VERIFICATION'
                        ? 'border-[#B7791F]/30 border-t-4 border-t-[#B7791F]'
                        : 'border-[#C0362C]/30 border-t-4 border-t-[#C0362C]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {payResult.status === 'SUCCESS' ? (
                          <div className="w-8 h-8 rounded-full bg-[#1E8E5A]/10 text-[#1E8E5A] flex items-center justify-center">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        ) : payResult.status === 'PENDING_VERIFICATION' ? (
                          <div className="w-8 h-8 rounded-full bg-[#B7791F]/10 text-[#B7791F] flex items-center justify-center">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                          </div>
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-[#C0362C]/10 text-[#C0362C] flex items-center justify-center">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </div>
                        )}
                        <div>
                          <div className="text-[16px] font-semibold text-[#1B2433]">
                            {payResult.status === 'SUCCESS'
                              ? 'Payment Completed Successfully'
                              : payResult.status === 'PENDING_VERIFICATION'
                              ? 'Security Authorization Required'
                              : 'Payment Declined by Fraud Protection'}
                          </div>
                          <div className="text-[11px] text-[#5B6575]">
                            {new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                          </div>
                        </div>
                      </div>
                      <DecisionBadge decision={payResult.status === 'SUCCESS' ? 'ALLOW' : payResult.status === 'PENDING_VERIFICATION' ? 'REVIEW' : 'BLOCK'} />
                    </div>

                    <p className="text-[13px] text-[#1B2433] leading-relaxed mt-2">{payResult.message}</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 pt-3 border-t border-[#E3E7EE] text-[12px] text-[#5B6575] font-mono tabular-nums">
                      <div>
                        Reference / UTR:{' '}
                        <span className="text-[#1B2433] font-medium select-all">{payResult.reference_id || payResult.payment_id}</span>
                      </div>
                      <div>
                        Processing Latency: <span className="font-semibold text-[#1B2433]">{payResult.total_ms.toFixed(1)} ms</span>
                      </div>
                      <div>
                        Risk Assessment: <span className="font-semibold text-[#1B2433]">{payResult.risk_score}</span> / 100
                      </div>
                      <div>
                        Remaining Balance:{' '}
                        <span className="font-semibold text-[#1B2433]">
                          ₹{payResult.sender_balance_after !== null && payResult.sender_balance_after !== undefined
                            ? payResult.sender_balance_after.toLocaleString('en-IN', { minimumFractionDigits: 2 })
                            : '—'}
                        </span>
                      </div>
                    </div>

                    {/* Official Receipt Action */}
                    {(payResult.status === 'SUCCESS' || payResult.status === 'DECLINED') && payResult.reference_id && (
                      <div className="mt-4 pt-3 border-t border-[#E3E7EE] flex justify-end">
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
                          className="px-3.5 py-1.5 text-[12px] font-medium text-[#1F4FD8] bg-[#EEF3FD] hover:bg-[#DCE7FB] rounded-[6px] transition-colors flex items-center gap-1.5"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <span>{isReceiptLoading ? 'Loading receipt...' : 'View Official Receipt'}</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 2FA Verification Box when PENDING_VERIFICATION */}
                  {payResult.status === 'PENDING_VERIFICATION' && (
                    <div className="p-4 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[8px] space-y-3 shadow-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-[#1B2433]">Bank Security Code (2FA)</span>
                        {payResult.demo_otp && (
                          <button
                            type="button"
                            onClick={() => setOtpInput(payResult.demo_otp!)}
                            className="text-[11px] font-mono font-medium px-2 py-0.5 bg-[#EEF3FD] text-[#1F4FD8] border border-[#1F4FD8]/20 rounded hover:bg-[#DCE7FB]"
                          >
                            Passcode: {payResult.demo_otp} (Tap to fill)
                          </button>
                        )}
                      </div>
                      <p className="text-[12px] text-[#5B6575]">
                        Enter the 6-digit verification code to confirm and settle this transfer.
                      </p>

                      {confirmError && (
                        <div className="p-2.5 bg-[#C0362C]/10 border border-[#C0362C]/20 rounded-[4px] text-[12px] text-[#C0362C]">
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
                          className="flex-1 px-3 py-2 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] font-mono text-[14px] text-[#1B2433] focus:border-[#1F4FD8] focus:ring-1 focus:ring-[#1F4FD8]"
                        />
                        <button
                          type="submit"
                          disabled={isConfirming}
                          className="px-4 py-2 bg-[#1F4FD8] text-[#FFFFFF] text-[13px] font-medium rounded-[6px] hover:bg-[#183EB0] disabled:opacity-50 transition-colors whitespace-nowrap min-h-[44px]"
                        >
                          {isConfirming ? 'Verifying...' : 'Confirm Transfer'}
                        </button>
                      </form>
                    </div>
                  )}

                  {/* Evaluated security rules */}
                  <div>
                    <h2 className="text-[13px] font-semibold text-[#1B2433] mb-2">Security Evaluation Summary</h2>
                    {payResult.reasons.length === 0 ? (
                      <p className="text-[12px] text-[#5B6575]">
                        All risk rules passed. No anomalous patterns detected.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {payResult.reasons.map((r, i) => (
                          <div
                            key={i}
                            className="p-2.5 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] text-[12px]"
                          >
                            <div className="font-medium text-[#1B2433]">{r.detail}</div>
                            <div className="text-[#5B6575] text-[11px] mt-0.5">
                              Rule: {r.rule} · Impact weight: {r.weight}
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
                    className={`p-5 bg-[#FFFFFF] border rounded-[8px] shadow-xs ${
                      rzpOutcome.status === 'VERIFIED'
                        ? 'border-[#1E8E5A]/30 border-t-4 border-t-[#1E8E5A]'
                        : rzpOutcome.status === 'BLOCKED'
                        ? 'border-[#C0362C]/30 border-t-4 border-t-[#C0362C]'
                        : 'border-[#5B6575]/30 border-t-4 border-t-[#5B6575]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[16px] font-semibold text-[#1B2433]">
                        {rzpOutcome.status === 'VERIFIED'
                          ? 'Payment Completed Successfully'
                          : rzpOutcome.status === 'BLOCKED'
                          ? 'Payment Declined by Fraud Protection'
                          : 'Payment Session Interrupted'}
                      </div>
                      <DecisionBadge decision={rzpOutcome.decision} score={rzpOutcome.risk_score} />
                    </div>
                    <p className="text-[13px] text-[#1B2433] leading-relaxed">{rzpOutcome.message}</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4 pt-3 border-t border-[#E3E7EE] text-[12px] text-[#5B6575] font-mono tabular-nums">
                      {rzpOutcome.order_id && (
                        <div className="break-all">
                          Order ID: <span className="text-[#1B2433] font-medium">{rzpOutcome.order_id}</span>
                        </div>
                      )}
                      {rzpOutcome.payment_id && (
                        <div className="break-all">
                          Payment ID: <span className="text-[#1B2433] font-medium">{rzpOutcome.payment_id}</span>
                        </div>
                      )}
                      {rzpOutcome.response_ms && (
                        <div>
                          Verification Latency:{' '}
                          <span className="font-semibold text-[#1B2433]">
                            {rzpOutcome.response_ms.toFixed(1)} ms
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Evaluated reasons */}
                  <div>
                    <h2 className="text-[13px] font-semibold text-[#1B2433] mb-2">Security Evaluation Summary</h2>
                    {rzpOutcome.reasons.length === 0 ? (
                      <p className="text-[12px] text-[#5B6575]">
                        All risk rules passed. No anomalous patterns detected.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {rzpOutcome.reasons.map((r, i) => (
                          <div
                            key={i}
                            className="p-2.5 bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] text-[12px]"
                          >
                            <div className="font-medium text-[#1B2433]">{r.detail}</div>
                            <div className="text-[#5B6575] text-[11px] mt-0.5">
                              Rule: {r.rule} · Impact weight: {r.weight}
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
                    className="w-1/2 min-h-[44px] py-2 px-3 border border-[#DCE0E7] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
                  >
                    {onBackToPayHome ? '← Payment Hub' : 'Back to Dashboard'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleReset}
                  className="flex-1 min-h-[44px] py-2 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors flex items-center justify-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  <span>New Transfer</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* --- RECENT STATEMENT / LEDGER --- */}
        <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[10px] p-5 shadow-xs">
          <div className="flex items-center justify-between mb-3 border-b border-[#E3E7EE] pb-2">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-[#1F4FD8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <h2 className="text-[14px] font-semibold text-[#1B2433]">
                {gatewayMode === 'simulated' ? 'Account Transfer Ledger' : 'Razorpay Settlement Ledger'}
              </h2>
            </div>
            <span className="text-[11px] text-[#5B6575] font-mono tabular-nums">
              {gatewayMode === 'simulated' ? recentPayments.length : rzpPayments.length} records
            </span>
          </div>

          {gatewayMode === 'simulated' ? (
            recentPayments.length === 0 ? (
              <p className="text-[12px] text-[#5B6575] text-center py-4">
                No transactions recorded yet in this session.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#E3E7EE] text-[#5B6575]">
                      <th className="py-2 pr-2 font-normal">Sender</th>
                      <th className="py-2 px-2 font-normal">Recipient</th>
                      <th className="py-2 px-2 font-normal text-right">Amount</th>
                      <th className="py-2 px-2 font-normal text-center">Status</th>
                      <th className="py-2 pl-2 font-normal text-right">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E3E7EE]">
                    {recentPayments.map((p, idx) => {
                      let badgeClass = 'bg-[#1E8E5A]/10 text-[#1E8E5A]';
                      let statusLabel = 'Settled';

                      if (p.status === 'PENDING_VERIFICATION') {
                        badgeClass = 'bg-[#B7791F]/10 text-[#B7791F]';
                        statusLabel = 'Pending 2FA';
                      } else if (p.status === 'DECLINED') {
                        badgeClass = 'bg-[#C0362C]/10 text-[#C0362C]';
                        statusLabel = 'Declined';
                      } else if (p.status === 'FAILED') {
                        badgeClass = 'bg-[#5B6575]/10 text-[#5B6575]';
                        statusLabel = 'Failed';
                      }

                      const zebra = idx % 2 === 1 ? 'bg-[#F4F5F7]/30' : 'bg-[#FFFFFF]';
                      return (
                        <tr key={p.payment_id} className={`${zebra} hover:bg-[#EEF3FD]/50 transition-colors`}>
                          <td className="py-2.5 pr-2 font-mono text-[#1B2433]">{p.from_account}</td>
                          <td className="py-2.5 px-2 font-mono text-[#1B2433]">{p.to_account}</td>
                          <td className="py-2.5 px-2 text-right font-medium font-mono tabular-nums text-[#1B2433]">
                            ₹{p.amount.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                          </td>
                          <td className="py-2.5 px-2 text-center">
                            <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-[4px] ${badgeClass}`}>
                              {statusLabel}
                            </span>
                          </td>
                          <td className="py-2.5 pl-2 text-right">
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
                                className="text-[11px] font-medium text-[#1F4FD8] hover:underline whitespace-nowrap"
                              >
                                View
                              </button>
                            ) : (
                              <span className="text-[#5B6575] text-[11px]">—</span>
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
              <p className="text-[12px] text-[#5B6575] text-center py-4">
                No Razorpay transactions recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px] border-collapse">
                  <thead>
                    <tr className="border-b border-[#E3E7EE] text-[#5B6575]">
                      <th className="py-2 pr-2 font-normal">Order Reference</th>
                      <th className="py-2 px-2 font-normal text-right">Amount</th>
                      <th className="py-2 px-2 font-normal text-center">Risk Score</th>
                      <th className="py-2 pl-2 font-normal text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E3E7EE]">
                    {rzpPayments.map((p, idx) => {
                      let badgeClass = 'bg-[#1E8E5A]/10 text-[#1E8E5A]';
                      let statusLabel: string = p.status;

                      if (p.status === 'VERIFIED' || p.status === 'CAPTURED') {
                        badgeClass = 'bg-[#1E8E5A]/10 text-[#1E8E5A]';
                        statusLabel = 'Captured';
                      } else if (p.status === 'ORDER_CREATED') {
                        badgeClass = 'bg-[#1F4FD8]/10 text-[#1F4FD8]';
                        statusLabel = 'Created';
                      } else if (p.status === 'BLOCKED' || p.status === 'TAMPERED' || p.status === 'FAILED') {
                        badgeClass = 'bg-[#C0362C]/10 text-[#C0362C]';
                        statusLabel = p.status === 'BLOCKED' ? 'Blocked' : 'Declined';
                      }

                      const zebra = idx % 2 === 1 ? 'bg-[#F4F5F7]/30' : 'bg-[#FFFFFF]';
                      return (
                        <tr key={p.order_id} className={`${zebra} hover:bg-[#EEF3FD]/50 transition-colors`}>
                          <td className="py-2.5 pr-2 font-mono text-[11px] text-[#1B2433] max-w-[140px] truncate" title={p.order_id}>
                            {p.order_id}
                          </td>
                          <td className="py-2.5 px-2 text-right font-medium font-mono tabular-nums text-[#1B2433]">
                            ₹{p.amount.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <DecisionBadge decision={p.decision} score={p.risk_score} />
                          </td>
                          <td className="py-2.5 pl-2 text-right">
                            <span className={`inline-block px-2 py-0.5 text-[10px] font-medium rounded-[4px] ${badgeClass}`}>
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
