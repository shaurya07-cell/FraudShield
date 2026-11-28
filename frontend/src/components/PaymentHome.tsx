import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchGatewayAccount,
  fetchGatewayPayments,
  fetchRazorpayConfig,
  fetchRazorpayPayments,
  fetchPaymentReceipt,
  PaymentReceipt,
} from '../services/api';
import type {
  GatewayAccount,
  GatewayPaymentRecord,
  RazorpayConfig,
  RazorpayPaymentRecord,
} from '../types/fraud';
import { BottomNavBar, BottomNavTab } from './BottomNavBar';
import { PaymentReceiptModal } from './PaymentReceiptModal';

type PayHomeTab = 'recent' | 'contacts' | 'security';

interface PaymentHomeProps {
  onNavigateToSend: (mode: 'simulated' | 'razorpay', options?: { autoScan?: boolean; selfTransfer?: boolean }) => void;
  onBackToDashboard: () => void;
}

export const PaymentHome: React.FC<PaymentHomeProps> = ({
  onNavigateToSend,
  onBackToDashboard,
}) => {
  const [razorpayConfig, setRazorpayConfig] = useState<RazorpayConfig | null>(null);
  const [senderAccount, setSenderAccount] = useState<GatewayAccount | null>(null);
  const [recentPayments, setRecentPayments] = useState<GatewayPaymentRecord[]>([]);
  const [rzpPayments, setRzpPayments] = useState<RazorpayPaymentRecord[]>([]);
  const [activeHomeTab, setActiveHomeTab] = useState<PayHomeTab>('recent');
  const [bottomNav, setBottomNav] = useState<BottomNavTab>('home');
  const [selectedReceipt, setSelectedReceipt] = useState<PaymentReceipt | null>(null);
  const [featureBannerIdx, setFeatureBannerIdx] = useState(0);

  // Load configs & primary account balance
  useEffect(() => {
    fetchRazorpayConfig()
      .then((cfg) => setRazorpayConfig(cfg))
      .catch(() => setRazorpayConfig({ enabled: false, mode: 'test' }));

    fetchGatewayAccount('ACC_0010')
      .then((acc) => setSenderAccount(acc))
      .catch(() => setSenderAccount(null));
  }, []);

  // Poll transactions
  const loadPayments = useCallback(async () => {
    try {
      const [sim, rzp] = await Promise.all([
        fetchGatewayPayments(8),
        fetchRazorpayPayments(8),
      ]);
      setRecentPayments(sim);
      setRzpPayments(rzp);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    loadPayments();
    const interval = setInterval(loadPayments, 4000);
    return () => clearInterval(interval);
  }, [loadPayments]);

  // Auto-rotate security feature banner
  useEffect(() => {
    const timer = setInterval(() => setFeatureBannerIdx((i) => (i + 1) % 3), 6000);
    return () => clearInterval(timer);
  }, []);

  const handleBottomNav = (tab: BottomNavTab) => {
    setBottomNav(tab);
  };

  const securityBanners = [
    {
      title: 'Real-Time ML Fraud Shield',
      desc: 'Ensemble model scoring every transaction within 50ms latency limit',
      color: 'from-[#17202E] to-[#1F2D42]',
      icon: (
        <svg className="w-9 h-9 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
    },
    {
      title: 'Graph Collusion Detection',
      desc: 'Continuous graph topology inspection uncovering mule accounts & cycle rings',
      color: 'from-[#13805B] to-[#1A6C4D]',
      icon: (
        <svg className="w-9 h-9 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      ),
    },
    {
      title: 'Bank-Grade 2FA Authorization',
      desc: 'Automatic risk-based step-up authentication on suspicious velocity spikes',
      color: 'from-[#1F4FD8] to-[#183EB0]',
      icon: (
        <svg className="w-9 h-9 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
      ),
    },
  ];

  const currentBanner = securityBanners[featureBannerIdx];

  // Merged recent activity from ledgers
  const mergedRecent = [
    ...recentPayments.map((p) => ({
      id: p.payment_id,
      type: 'simulated' as const,
      from: p.from_account,
      to: p.to_account,
      amount: p.amount,
      status: p.status,
      reference_id: p.reference_id,
      created_at: p.created_at,
    })),
    ...rzpPayments.map((p) => ({
      id: p.order_id,
      type: 'razorpay' as const,
      from: 'ACC_0010',
      to: 'Razorpay Merchant',
      amount: p.amount,
      status: p.status,
      reference_id: undefined as string | undefined,
      created_at: p.created_at,
    })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 10);

  const getStatusBadge = (status: string) => {
    if (status === 'SUCCESS' || status === 'VERIFIED' || status === 'CAPTURED')
      return { cls: 'bg-[#1E8E5A]/10 text-[#1E8E5A]', label: 'Settled' };
    if (status === 'PENDING_VERIFICATION' || status === 'ORDER_CREATED')
      return { cls: 'bg-[#B7791F]/10 text-[#B7791F]', label: 'Pending 2FA' };
    if (status === 'DECLINED' || status === 'BLOCKED' || status === 'TAMPERED')
      return { cls: 'bg-[#C0362C]/10 text-[#C0362C]', label: 'Declined' };
    return { cls: 'bg-[#5B6575]/10 text-[#5B6575]', label: 'Failed' };
  };

  /* ───────── Render: Account Profile sub-view ───────── */
  if (bottomNav === 'account') {
    return (
      <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
        <div className="max-w-[560px] mx-auto px-4 pt-6 space-y-4">
          <div className="bg-white border border-[#DCE0E7] rounded-[10px] p-5 shadow-xs">
            <div className="flex items-center gap-3.5 mb-5 pb-4 border-b border-[#E3E7EE]">
              <div className="w-14 h-14 rounded-full bg-[#1F4FD8] text-white flex items-center justify-center text-[18px] font-semibold font-mono shadow-xs">
                {senderAccount?.name ? senderAccount.name.split(' ').map((n) => n[0]).join('') : 'FS'}
              </div>
              <div>
                <div className="text-[17px] font-semibold text-[#1B2433]">{senderAccount?.name || 'Aarav Sharma'}</div>
                <div className="text-[12px] font-mono text-[#5B6575]">Account ID: {senderAccount?.id || 'ACC_0010'}</div>
                <div className="text-[11px] text-[#1E8E5A] font-medium flex items-center gap-1 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#1E8E5A]" />
                  <span>Verified Identity · KYC Complete</span>
                </div>
              </div>
            </div>

            {/* Debit Card Replica */}
            <div className="p-4 bg-gradient-to-r from-[#17202E] to-[#1F2D42] rounded-[8px] text-white shadow-sm space-y-3">
              <div className="flex items-center justify-between text-[11px] text-white/70">
                <span className="font-semibold tracking-wider text-white">FRAUDSHIELD PLATINUM</span>
                <span className="font-mono text-white/60">SAVINGS</span>
              </div>
              <div className="text-[18px] font-mono tracking-widest text-white/90">
                •••• •••• •••• {senderAccount?.id ? senderAccount.id.slice(-4) : '0010'}
              </div>
              <div className="flex justify-between items-end pt-1">
                <div>
                  <div className="text-[9px] text-white/60 uppercase">Available Balance</div>
                  <div className="text-[20px] font-bold font-mono text-white">
                    ₹{senderAccount ? senderAccount.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '1,84,250.00'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[9px] text-white/60 uppercase">Account Holder</div>
                  <div className="text-[11px] font-medium text-white">{senderAccount?.name || 'Aarav Sharma'}</div>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-[#E3E7EE] flex justify-between items-center text-[12px]">
              <span className="text-[#5B6575]">Account Status</span>
              <span className="font-medium text-[#1E8E5A] bg-[#1E8E5A]/10 px-2 py-0.5 rounded-[4px]">Active & Protected</span>
            </div>
          </div>
        </div>
        <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
      </div>
    );
  }

  /* ───────── Render: All Transactions Statement ───────── */
  if (bottomNav === 'transactions') {
    return (
      <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
        <div className="max-w-[560px] mx-auto px-4 pt-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[16px] font-semibold text-[#1B2433]">Account Statement</h2>
            <span className="text-[12px] font-mono text-[#5B6575]">{mergedRecent.length} transactions</span>
          </div>

          {mergedRecent.length === 0 ? (
            <div className="bg-white border border-[#DCE0E7] rounded-[10px] text-center py-12 text-[13px] text-[#5B6575]">
              No transactions recorded yet. Initiate your first transfer.
            </div>
          ) : (
            <div className="bg-white border border-[#DCE0E7] rounded-[10px] divide-y divide-[#E3E7EE] shadow-xs">
              {mergedRecent.map((tx) => {
                const badge = getStatusBadge(tx.status);
                return (
                  <div
                    key={tx.id}
                    className="p-3.5 flex items-center justify-between hover:bg-[#F4F5F7]/60 transition-colors cursor-pointer"
                    onClick={async () => {
                      if (tx.reference_id) {
                        try {
                          const rcp = await fetchPaymentReceipt(tx.reference_id);
                          setSelectedReceipt(rcp);
                        } catch {
                          // silent
                        }
                      }
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-[#1F4FD8]/10 text-[#1F4FD8] flex items-center justify-center text-[12px] font-semibold font-mono flex-shrink-0">
                        {tx.to.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-[#1B2433] truncate">{tx.to}</div>
                        <div className="text-[11px] text-[#5B6575] font-mono">
                          {new Date(tx.created_at).toLocaleString('en-IN', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      <div className="text-[14px] font-bold font-mono text-[#1B2433]">
                        ₹{tx.amount.toLocaleString('en-IN')}
                      </div>
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
      </div>
    );
  }

  /* ───────── Render: Settings & Network Specs ───────── */
  if (bottomNav === 'settings') {
    return (
      <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
        <div className="max-w-[560px] mx-auto px-4 pt-6 space-y-3">
          <h2 className="text-[16px] font-semibold text-[#1B2433]">Security & Network Settings</h2>
          <div className="bg-white border border-[#DCE0E7] rounded-[10px] divide-y divide-[#E3E7EE] shadow-xs">
            <div className="p-4 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-[#1B2433]">Payment Rails</div>
                <div className="text-[11px] text-[#5B6575]">Instant UPI / IMPS & Razorpay Checkout</div>
              </div>
              <span className="text-[11px] font-medium text-[#1E8E5A] bg-[#1E8E5A]/10 px-2 py-0.5 rounded-[4px]">
                {razorpayConfig?.enabled ? 'Online (Multi-Rail)' : 'Online (UPI Rail)'}
              </span>
            </div>
            <div className="p-4 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-[#1B2433]">Fraud Protection Engine</div>
                <div className="text-[11px] text-[#5B6575]">ML v3 Pipeline with Mule Account Classifier</div>
              </div>
              <span className="text-[11px] font-medium text-[#1F4FD8] bg-[#EEF3FD] px-2 py-0.5 rounded-[4px]">Active</span>
            </div>
            <div className="p-4 flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-[#1B2433]">Graph Ring Detector</div>
                <div className="text-[11px] text-[#5B6575]">Real-time cycle & counterparty network scan</div>
              </div>
              <span className="text-[11px] font-medium text-[#13805B] bg-[#13805B]/10 px-2 py-0.5 rounded-[4px]">Enabled</span>
            </div>
            <button
              type="button"
              onClick={onBackToDashboard}
              className="w-full p-4 text-left text-[13px] text-[#1F4FD8] font-medium hover:bg-[#F4F5F7] transition-colors flex items-center justify-between"
            >
              <span>← Back to Operations Console</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
        <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
      </div>
    );
  }

  /* ───────── Render: HOME (Main Professional Banking Hub) ───────── */
  return (
    <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
      <div className="max-w-[560px] mx-auto">
        {/* ─── Top Brand Header ─── */}
        <div className="bg-[#17202E] px-4 pt-5 pb-6 rounded-b-[18px] shadow-sm text-white">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-[#1F4FD8] flex items-center justify-center text-white">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div>
                <span className="font-semibold text-[16px] text-white tracking-tight">FraudShield Pay</span>
                <div className="text-[10px] text-white/60">Federal Switch · Instant Settlement</div>
              </div>
            </div>
            <div className="flex items-center gap-1 px-2.5 py-0.5 bg-[#1E8E5A]/20 border border-[#1E8E5A]/30 rounded-full text-[#1E8E5A] text-[11px] font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-[#1E8E5A]" />
              <span>Live Rail</span>
            </div>
          </div>

          {/* Balance Preview Card */}
          <div className="bg-white/5 border border-white/10 rounded-[10px] p-3.5 flex items-center justify-between">
            <div>
              <div className="text-[10px] text-white/60 uppercase tracking-wider">Available Balance</div>
              <div className="text-[22px] font-bold font-mono text-white tabular-nums">
                ₹{senderAccount ? senderAccount.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '1,84,250.00'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[12px] font-medium text-white/90">{senderAccount?.name || 'Aarav Sharma'}</div>
              <div className="text-[11px] font-mono text-white/50">•••• 0010</div>
            </div>
          </div>
        </div>

        {/* ─── Fast Payment Actions Grid ─── */}
        <div className="px-4 -mt-3">
          <div className="bg-white border border-[#DCE0E7] rounded-[10px] shadow-sm p-4">
            <div className="grid grid-cols-4 gap-2">
              {/* Action 1: UPI */}
              <button
                type="button"
                onClick={() => onNavigateToSend('simulated')}
                className="flex flex-col items-center gap-1.5 p-2 rounded-[8px] hover:bg-[#F4F5F7] transition-colors group"
              >
                <div className="w-12 h-12 rounded-[10px] bg-[#EEF3FD] border border-[#1F4FD8]/20 flex items-center justify-center text-[#1F4FD8] group-hover:scale-105 transition-transform">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">To UPI</div>
                  <div className="text-[10px] text-[#5B6575]">Instant</div>
                </div>
              </button>

              {/* Action 2: Cards / Razorpay */}
              <button
                type="button"
                onClick={() => onNavigateToSend('razorpay')}
                className="flex flex-col items-center gap-1.5 p-2 rounded-[8px] hover:bg-[#F4F5F7] transition-colors group"
              >
                <div className="w-12 h-12 rounded-[10px] bg-[#F4F5F7] border border-[#DCE0E7] flex items-center justify-center text-[#17202E] group-hover:scale-105 transition-transform">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">Card / Net</div>
                  <div className="text-[10px] text-[#5B6575]">Razorpay</div>
                </div>
              </button>

              {/* Action 3: Scan QR */}
              <button
                type="button"
                onClick={() => onNavigateToSend('simulated', { autoScan: true })}
                className="flex flex-col items-center gap-1.5 p-2 rounded-[8px] hover:bg-[#F4F5F7] transition-colors group"
              >
                <div className="w-12 h-12 rounded-[10px] bg-[#1E8E5A]/10 border border-[#1E8E5A]/20 flex items-center justify-center text-[#1E8E5A] group-hover:scale-105 transition-transform">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">Scan QR</div>
                  <div className="text-[10px] text-[#5B6575]">Camera</div>
                </div>
              </button>

              {/* Action 4: Self Transfer */}
              <button
                type="button"
                onClick={() => onNavigateToSend('simulated', { selfTransfer: true })}
                className="flex flex-col items-center gap-1.5 p-2 rounded-[8px] hover:bg-[#F4F5F7] transition-colors group"
              >
                <div className="w-12 h-12 rounded-[10px] bg-[#6B4FD1]/10 border border-[#6B4FD1]/20 flex items-center justify-center text-[#6B4FD1] group-hover:scale-105 transition-transform">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">Self</div>
                  <div className="text-[10px] text-[#5B6575]">Transfer</div>
                </div>
              </button>
            </div>
          </div>
        </div>

        {/* ─── Institutional Security Carousel ─── */}
        <div className="px-4 mt-4">
          <div className={`w-full bg-gradient-to-r ${currentBanner.color} rounded-[10px] p-4 flex items-center gap-4 text-left shadow-xs transition-all duration-500`}>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-white">{currentBanner.title}</div>
              <div className="text-[11px] text-white/80 mt-1 leading-relaxed">{currentBanner.desc}</div>
            </div>
            {currentBanner.icon}
          </div>
          {/* Indicator dots */}
          <div className="flex justify-center gap-1.5 mt-2">
            {securityBanners.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setFeatureBannerIdx(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === featureBannerIdx ? 'bg-[#1F4FD8]' : 'bg-[#DCE0E7]'
                }`}
                aria-label={`Security Slide ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {/* ─── Navigation Tabs ─── */}
        <div className="px-4 mt-4">
          <div className="flex border-b border-[#DCE0E7]">
            {[
              { id: 'recent' as const, label: 'Recent Transfers' },
              { id: 'contacts' as const, label: 'Saved Beneficiaries' },
              { id: 'security' as const, label: 'Safety Overview' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveHomeTab(tab.id)}
                className={`flex-1 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
                  activeHomeTab === tab.id
                    ? 'text-[#1F4FD8] border-[#1F4FD8] font-semibold'
                    : 'text-[#5B6575] border-transparent hover:text-[#1B2433]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Tab Content ─── */}
        {activeHomeTab === 'recent' && (
          <div className="px-4 mt-3 space-y-2">
            {mergedRecent.length === 0 ? (
              <div className="bg-white border border-[#DCE0E7] rounded-[10px] p-6 text-center shadow-xs">
                <div className="text-[13px] font-medium text-[#1B2433]">No recent transactions</div>
                <div className="text-[11px] text-[#5B6575] mt-1">Tap 'To UPI' or 'Scan QR' above to make a payment.</div>
              </div>
            ) : (
              mergedRecent.slice(0, 5).map((tx) => {
                const badge = getStatusBadge(tx.status);
                return (
                  <div
                    key={tx.id}
                    className="bg-white border border-[#DCE0E7] rounded-[8px] p-3 flex items-center justify-between hover:bg-[#F4F5F7] transition-colors cursor-pointer shadow-xs"
                    onClick={async () => {
                      if (tx.reference_id) {
                        try {
                          const rcp = await fetchPaymentReceipt(tx.reference_id);
                          setSelectedReceipt(rcp);
                        } catch {
                          // silent
                        }
                      }
                    }}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-full bg-[#1F4FD8]/10 text-[#1F4FD8] flex items-center justify-center text-[12px] font-semibold font-mono flex-shrink-0">
                        {tx.to.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-[#1B2433] truncate">{tx.to}</div>
                        <div className="text-[11px] text-[#5B6575] font-mono">
                          {new Date(tx.created_at).toLocaleString('en-IN', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      <div className="text-[14px] font-bold font-mono text-[#1B2433]">
                        ₹{tx.amount.toLocaleString('en-IN')}
                      </div>
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badge.cls}`}>
                        {badge.label}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeHomeTab === 'contacts' && (
          <div className="px-4 mt-3 space-y-2">
            {[
              { name: 'Rohan Sharma', handle: 'rohan.sharma@upi', id: 'ACC_0015', tag: 'Verified Contact' },
              { name: 'Priya Patel', handle: 'priya.patel@upi', id: 'ACC_0042', tag: 'Verified Merchant' },
              { name: 'CloudRetail Solutions', handle: 'merchant@razorpay', id: 'success@razorpay', tag: 'Commercial Partner' },
              { name: 'Vikram Malhotra', handle: 'vikram.m@upi', id: 'ACC_0120', tag: 'Verified Contact' },
            ].map((contact) => (
              <div
                key={contact.id}
                onClick={() => onNavigateToSend('simulated')}
                className="bg-white border border-[#DCE0E7] rounded-[8px] p-3 flex items-center justify-between hover:bg-[#F4F5F7] transition-colors cursor-pointer shadow-xs"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-[#1F4FD8] text-white flex items-center justify-center font-mono text-[12px] font-semibold">
                    {contact.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold text-[#1B2433]">{contact.name}</div>
                    <div className="text-[11px] font-mono text-[#5B6575]">{contact.handle}</div>
                  </div>
                </div>
                <span className="text-[10px] font-medium text-[#1E8E5A] bg-[#1E8E5A]/10 px-2 py-0.5 rounded-[4px]">
                  {contact.tag}
                </span>
              </div>
            ))}
          </div>
        )}

        {activeHomeTab === 'security' && (
          <div className="px-4 mt-3 bg-white border border-[#DCE0E7] rounded-[10px] p-4 space-y-3 shadow-xs">
            <div className="text-[13px] font-semibold text-[#1B2433]">FraudShield Institutional Security</div>
            <p className="text-[12px] text-[#5B6575] leading-relaxed">
              Every payment processed through FraudShield Pay is evaluated against machine learning models and dynamic graph topology algorithms to block unauthorized charges, money mule rings, and account takeovers before funds settle.
            </p>
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[#E3E7EE] text-[11px]">
              <div>
                <span className="text-[#5B6575]">Encryption:</span> <strong className="text-[#1B2433]">TLS 1.3 + AES-256</strong>
              </div>
              <div>
                <span className="text-[#5B6575]">SLA Latency:</span> <strong className="text-[#1B2433]">&lt;50ms per check</strong>
              </div>
            </div>
          </div>
        )}

        {/* Structured Payment Receipt Modal */}
        <PaymentReceiptModal
          receipt={selectedReceipt}
          onClose={() => setSelectedReceipt(null)}
        />
      </div>

      {/* Persistent Bottom Navigation */}
      <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
    </div>
  );
};
