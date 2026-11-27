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

type PayHomeTab = 'recent' | 'people' | 'settings';

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

  // Load configs & data
  useEffect(() => {
    fetchRazorpayConfig()
      .then((cfg) => setRazorpayConfig(cfg))
      .catch(() => setRazorpayConfig({ enabled: false, mode: 'test' }));

    fetchGatewayAccount('ACC_0010')
      .then((acc) => setSenderAccount(acc))
      .catch(() => setSenderAccount(null));
  }, []);

  // Poll both ledgers
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

  // Auto-rotate feature banner
  useEffect(() => {
    const timer = setInterval(() => setFeatureBannerIdx((i) => (i + 1) % 3), 5000);
    return () => clearInterval(timer);
  }, []);

  const handleBottomNav = (tab: BottomNavTab) => {
    if (tab === 'home') {
      setBottomNav('home');
    } else if (tab === 'transactions') {
      setBottomNav('transactions');
    } else if (tab === 'account') {
      setBottomNav('account');
    } else {
      setBottomNav('settings');
    }
  };

  const featureBanners = [
    {
      title: 'Real-time fraud detection',
      desc: 'Every payment is scored by an ML ensemble + graph engine in <50ms',
      color: 'from-[#1F4FD8] to-[#3B6DE8]',
      icon: (
        <svg className="w-10 h-10 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
        </svg>
      ),
    },
    {
      title: 'Graph-based ring detection',
      desc: 'Detect circular transaction patterns and collusion networks automatically',
      color: 'from-[#13805B] to-[#1E9E6E]',
      icon: (
        <svg className="w-10 h-10 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      ),
    },
    {
      title: 'Razorpay test mode',
      desc: 'Test real payment flows safely with Razorpay checkout integration',
      color: 'from-[#2B3545] to-[#3D4F6A]',
      icon: (
        <svg className="w-10 h-10 text-white/90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      ),
    },
  ];

  const currentBanner = featureBanners[featureBannerIdx];

  // Merged recent activity from both ledgers
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
      to: '—',
      amount: p.amount,
      status: p.status,
      reference_id: undefined as string | undefined,
      created_at: p.created_at,
    })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 10);

  const getStatusBadge = (status: string) => {
    if (status === 'SUCCESS' || status === 'VERIFIED' || status === 'CAPTURED')
      return { cls: 'bg-[#13805B]/10 text-[#13805B]', label: status === 'SUCCESS' ? 'Success' : 'Verified' };
    if (status === 'PENDING_VERIFICATION' || status === 'ORDER_CREATED')
      return { cls: 'bg-[#B7791F]/10 text-[#B7791F]', label: status === 'PENDING_VERIFICATION' ? 'Pending' : 'Created' };
    if (status === 'DECLINED' || status === 'BLOCKED' || status === 'TAMPERED')
      return { cls: 'bg-[#C53030]/10 text-[#C53030]', label: status === 'BLOCKED' ? 'Blocked' : 'Declined' };
    return { cls: 'bg-[#8A94A6]/10 text-[#8A94A6]', label: 'Failed' };
  };

  /* ───────── Render: Account & Settings sub-views ───────── */
  if (bottomNav === 'account') {
    return (
      <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
        <div className="max-w-[560px] mx-auto px-4 pt-6 space-y-4">
          <div className="bg-white border border-[#E3E7EE] rounded-[8px] p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-14 h-14 rounded-full bg-[#1F4FD8] text-white flex items-center justify-center text-[20px] font-semibold font-mono">FS</div>
              <div>
                <div className="text-[16px] font-semibold text-[#1B2433]">{senderAccount?.name || 'FraudShield User'}</div>
                <div className="text-[12px] font-mono text-[#8A94A6]">{senderAccount?.id || 'ACC_0010'}</div>
              </div>
            </div>
            <div className="p-3 bg-[#EEF3FD] rounded-[6px] border border-[#1F4FD8]/15">
              <div className="text-[11px] text-[#8A94A6] font-medium">Available Balance</div>
              <div className="text-[24px] font-semibold font-mono text-[#1F4FD8]">
                ₹{senderAccount ? senderAccount.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
              </div>
            </div>
            <div className="mt-3 text-[11px] text-[#8A94A6] text-center">
              Simulated account · Test mode · No real funds
            </div>
          </div>
        </div>
        <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
      </div>
    );
  }

  if (bottomNav === 'transactions') {
    return (
      <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
        <div className="max-w-[560px] mx-auto px-4 pt-5 space-y-3">
          <h2 className="text-[16px] font-semibold text-[#1B2433]">All Transactions</h2>
          {mergedRecent.length === 0 ? (
            <div className="text-center py-10 text-[13px] text-[#8A94A6]">No transactions yet. Start a payment from Home.</div>
          ) : (
            <div className="space-y-2">
              {mergedRecent.map((tx) => {
                const badge = getStatusBadge(tx.status);
                return (
                  <div key={tx.id} className="bg-white border border-[#E3E7EE] rounded-[8px] p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-semibold font-mono flex-shrink-0 ${
                        tx.type === 'razorpay' ? 'bg-[#2B3545] text-white' : 'bg-[#1F4FD8] text-white'
                      }`}>
                        {tx.type === 'razorpay' ? 'RP' : tx.to.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-[#1B2433] truncate">{tx.to}</div>
                        <div className="text-[11px] text-[#8A94A6] font-mono">
                          {new Date(tx.created_at).toLocaleString('en-IN', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <div className="text-[14px] font-semibold font-mono text-[#1B2433]">₹{tx.amount.toLocaleString('en-IN')}</div>
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badge.cls}`}>{badge.label}</span>
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

  if (bottomNav === 'settings') {
    return (
      <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
        <div className="max-w-[560px] mx-auto px-4 pt-6 space-y-3">
          <h2 className="text-[16px] font-semibold text-[#1B2433]">Settings</h2>
          <div className="bg-white border border-[#E3E7EE] rounded-[8px] divide-y divide-[#E3E7EE]">
            <div className="p-4 flex items-center justify-between">
              <span className="text-[13px] text-[#1B2433]">Gateway Mode</span>
              <span className="text-[12px] font-mono text-[#8A94A6]">Simulated + Razorpay</span>
            </div>
            <div className="p-4 flex items-center justify-between">
              <span className="text-[13px] text-[#1B2433]">Razorpay</span>
              <span className={`text-[12px] font-medium ${razorpayConfig?.enabled ? 'text-[#13805B]' : 'text-[#8A94A6]'}`}>
                {razorpayConfig?.enabled ? 'Enabled (test)' : 'Disabled'}
              </span>
            </div>
            <div className="p-4 flex items-center justify-between">
              <span className="text-[13px] text-[#1B2433]">Fraud Engine</span>
              <span className="text-[12px] font-mono text-[#13805B]">Active</span>
            </div>
            <button
              type="button"
              onClick={onBackToDashboard}
              className="w-full p-4 text-left text-[13px] text-[#1F4FD8] font-medium hover:bg-[#F4F5F7] transition-colors"
            >
              ← Back to Dashboard
            </button>
          </div>
        </div>
        <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
      </div>
    );
  }

  /* ───────── Render: HOME (main Amazon Pay-style layout) ───────── */
  return (
    <div className="w-full min-h-[calc(100vh-48px)] bg-[#F4F5F7] pb-[72px]">
      <div className="max-w-[560px] mx-auto">

        {/* ─── Top Header Bar ─── */}
        <div className="bg-[#1F4FD8] px-4 pt-4 pb-5 rounded-b-[20px] shadow-md">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-white/90" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="4" r="2.25" stroke="white" strokeWidth="2" fill="none" />
                <circle cx="5" cy="18" r="2.25" stroke="white/70" strokeWidth="1.75" fill="none" />
                <circle cx="19" cy="18" r="2.25" stroke="white/70" strokeWidth="1.75" fill="none" />
                <path d="M10.2 5.5L6.8 16.2" stroke="white/40" strokeWidth="1.5" />
                <path d="M13.8 5.5L17.2 16.2" stroke="white/40" strokeWidth="1.5" />
                <path d="M7.2 18h9.6" stroke="white" strokeWidth="1.5" />
              </svg>
              <span className="font-semibold text-[16px] text-white tracking-tight">FraudShield Pay</span>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 bg-white/15 rounded-full text-white/80 border border-white/20">
              Test mode
            </span>
          </div>

          {/* Search Bar */}
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#8A94A6]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search FraudShield Pay"
              className="w-full pl-9 pr-4 py-2.5 bg-white rounded-[10px] text-[13px] text-[#1B2433] placeholder-[#8A94A6] focus:outline-none focus:ring-2 focus:ring-white/40 shadow-sm"
              readOnly
            />
          </div>
        </div>

        {/* ─── Payment Method Icons Row ─── */}
        <div className="px-4 -mt-3">
          <div className="bg-white border border-[#E3E7EE] rounded-[12px] shadow-sm p-4">
            <div className="flex items-start justify-around">
              {/* UPI (Simulated) */}
              <button
                type="button"
                onClick={() => onNavigateToSend('simulated')}
                className="flex flex-col items-center gap-1.5 min-w-[64px] group"
              >
                <div className="w-14 h-14 rounded-[12px] bg-[#EEF3FD] border border-[#1F4FD8]/15 flex items-center justify-center group-hover:bg-[#DCE7FB] transition-colors">
                  <svg className="w-7 h-7 text-[#1F4FD8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">UPI</div>
                  <div className="text-[10px] text-[#8A94A6]">Simulated</div>
                </div>
              </button>

              {/* Razorpay */}
              <button
                type="button"
                onClick={() => onNavigateToSend('razorpay')}
                className={`flex flex-col items-center gap-1.5 min-w-[64px] group ${
                  !razorpayConfig?.enabled ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                disabled={!razorpayConfig?.enabled}
              >
                <div className="w-14 h-14 rounded-[12px] bg-[#2B3545]/8 border border-[#2B3545]/15 flex items-center justify-center group-hover:bg-[#2B3545]/15 transition-colors">
                  <svg className="w-7 h-7 text-[#2B3545]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">Razorpay</div>
                  <div className="text-[10px] text-[#8A94A6]">
                    {razorpayConfig?.enabled ? 'Test mode' : 'Disabled'}
                  </div>
                </div>
              </button>

              {/* Scan & Pay */}
              <button
                type="button"
                onClick={() => onNavigateToSend('simulated', { autoScan: true })}
                className="flex flex-col items-center gap-1.5 min-w-[64px] group"
              >
                <div className="w-14 h-14 rounded-[12px] bg-[#13805B]/8 border border-[#13805B]/15 flex items-center justify-center group-hover:bg-[#13805B]/15 transition-colors">
                  <svg className="w-7 h-7 text-[#13805B]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">Scan & Pay</div>
                  <div className="text-[10px] text-[#8A94A6]">QR code</div>
                </div>
              </button>

              {/* Balance */}
              <div className="flex flex-col items-center gap-1.5 min-w-[64px]">
                <div className="w-14 h-14 rounded-[12px] bg-[#F4F5F7] border border-[#E3E7EE] flex items-center justify-center">
                  <span className="text-[14px] font-semibold font-mono text-[#1B2433]">₹</span>
                </div>
                <div className="text-center">
                  <div className="text-[11px] font-semibold text-[#1B2433]">Balance</div>
                  <div className="text-[10px] text-[#8A94A6] font-mono">
                    ₹{senderAccount ? (senderAccount.balance / 1000).toFixed(0) + 'K' : '—'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Feature Banner Carousel ─── */}
        <div className="px-4 mt-4">
          <button
            type="button"
            className={`w-full bg-gradient-to-r ${currentBanner.color} rounded-[12px] p-4 flex items-center gap-4 text-left shadow-sm transition-all duration-500`}
            onClick={() => setFeatureBannerIdx((i) => (i + 1) % featureBanners.length)}
          >
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-white">{currentBanner.title}</div>
              <div className="text-[11px] text-white/75 mt-1 leading-relaxed">{currentBanner.desc}</div>
            </div>
            {currentBanner.icon}
          </button>
          {/* Dots */}
          <div className="flex justify-center gap-1.5 mt-2.5">
            {featureBanners.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setFeatureBannerIdx(i)}
                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                  i === featureBannerIdx ? 'bg-[#1F4FD8]' : 'bg-[#E3E7EE]'
                }`}
                aria-label={`Banner ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {/* ─── Tab Navigation ─── */}
        <div className="px-4 mt-4">
          <div className="flex border-b border-[#E3E7EE]">
            {[
              { id: 'recent' as const, label: 'Recent' },
              { id: 'people' as const, label: 'People' },
              { id: 'settings' as const, label: 'Info' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveHomeTab(tab.id)}
                className={`flex-1 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
                  activeHomeTab === tab.id
                    ? 'text-[#1F4FD8] border-[#1F4FD8]'
                    : 'text-[#8A94A6] border-transparent hover:text-[#1B2433]'
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
              <div className="bg-white border border-[#E3E7EE] rounded-[8px] p-6 text-center">
                <div className="text-[32px] mb-2">💳</div>
                <div className="text-[13px] text-[#8A94A6]">No recent transactions. Try sending a payment!</div>
              </div>
            ) : (
              mergedRecent.slice(0, 4).map((tx) => {
                const badge = getStatusBadge(tx.status);
                return (
                  <div
                    key={tx.id}
                    className="bg-white border border-[#E3E7EE] rounded-[8px] p-3 flex items-center justify-between hover:shadow-sm transition-shadow cursor-pointer"
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
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-semibold font-mono flex-shrink-0 ${
                        tx.type === 'razorpay' ? 'bg-[#2B3545] text-white' : 'bg-[#1F4FD8] text-white'
                      }`}>
                        {tx.type === 'razorpay' ? 'RP' : tx.to.slice(0, 2).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-[#1B2433] truncate">{tx.to}</div>
                        <div className="text-[10px] text-[#8A94A6]">
                          {tx.type === 'razorpay' ? 'Razorpay' : 'UPI'} · {new Date(tx.created_at).toLocaleString('en-IN', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <div className="text-[14px] font-semibold font-mono text-[#1B2433]">₹{tx.amount.toLocaleString('en-IN')}</div>
                      <span className={`inline-block px-1.5 py-0.5 text-[10px] font-medium rounded-[4px] ${badge.cls}`}>{badge.label}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {activeHomeTab === 'people' && (
          <div className="px-4 mt-3">
            <div className="bg-white border border-[#E3E7EE] rounded-[8px] p-5">
              <div className="text-[13px] font-medium text-[#1B2433] mb-3">Test Payees</div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { id: 'success@razorpay', name: 'Success', emoji: '✅' },
                  { id: 'failure@razorpay', name: 'Failure', emoji: '❌' },
                  { id: 'ACC_0001', name: 'Account 1', emoji: '👤' },
                  { id: 'ACC_0020', name: 'Account 20', emoji: '👤' },
                  { id: 'ACC_0050', name: 'Account 50', emoji: '👤' },
                  { id: 'ACC_0100', name: 'Account 100', emoji: '👤' },
                ].map((person) => (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => onNavigateToSend('simulated')}
                    className="flex flex-col items-center gap-1.5 p-2 rounded-[8px] hover:bg-[#F4F5F7] transition-colors"
                  >
                    <div className="w-10 h-10 rounded-full bg-[#EEF3FD] flex items-center justify-center text-[16px]">
                      {person.emoji}
                    </div>
                    <div className="text-[11px] text-[#1B2433] text-center leading-tight truncate w-full">{person.name}</div>
                    <div className="text-[9px] text-[#8A94A6] font-mono truncate w-full text-center">{person.id}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeHomeTab === 'settings' && (
          <div className="px-4 mt-3">
            <div className="bg-white border border-[#E3E7EE] rounded-[8px] p-4 space-y-3">
              <div className="p-3 bg-[#EEF3FD] rounded-[6px] border border-[#1F4FD8]/15">
                <div className="text-[13px] font-semibold text-[#1F4FD8]">About FraudShield Pay</div>
                <div className="text-[12px] text-[#1B2433] mt-1 leading-relaxed">
                  Real-time fraud detection gateway with ML ensemble scoring, graph-based ring detection, and UPI/Razorpay payment processing.
                </div>
              </div>
              <div className="text-[12px] text-[#8A94A6] space-y-1">
                <div>• Simulated UPI gateway with in-memory ledger</div>
                <div>• Razorpay test mode checkout integration</div>
                <div>• QR code scanning (upload, camera, manual)</div>
                <div>• Real-time fraud scoring on every payment</div>
                <div>• Payment state machine with OTP verification</div>
              </div>
            </div>
          </div>
        )}

        {/* ─── Money Transfer Section ─── */}
        <div className="px-4 mt-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[15px] font-semibold text-[#1B2433]">Money Transfer</h2>
            <button
              type="button"
              onClick={() => onNavigateToSend('simulated')}
              className="text-[12px] text-[#1F4FD8] font-medium hover:underline"
            >
              See more
            </button>
          </div>

          <div className="grid grid-cols-4 gap-3">
            {/* Scan Any QR */}
            <button
              type="button"
              onClick={() => onNavigateToSend('simulated', { autoScan: true })}
              className="flex flex-col items-center gap-2 group"
            >
              <div className="w-14 h-14 rounded-[14px] bg-white border border-[#E3E7EE] shadow-sm flex items-center justify-center group-hover:border-[#1F4FD8] group-hover:shadow-md transition-all">
                <svg className="w-7 h-7 text-[#1B2433] group-hover:text-[#1F4FD8] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                </svg>
              </div>
              <span className="text-[11px] text-[#1B2433] font-medium text-center leading-tight">Scan Any QR</span>
            </button>

            {/* Send Money */}
            <button
              type="button"
              onClick={() => onNavigateToSend('simulated')}
              className="flex flex-col items-center gap-2 group"
            >
              <div className="w-14 h-14 rounded-[14px] bg-white border border-[#E3E7EE] shadow-sm flex items-center justify-center group-hover:border-[#1F4FD8] group-hover:shadow-md transition-all">
                <svg className="w-7 h-7 text-[#1B2433] group-hover:text-[#1F4FD8] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              </div>
              <span className="text-[11px] text-[#1B2433] font-medium text-center leading-tight">Send Money</span>
            </button>

            {/* Self Transfer */}
            <button
              type="button"
              onClick={() => onNavigateToSend('simulated', { selfTransfer: true })}
              className="flex flex-col items-center gap-2 group"
            >
              <div className="w-14 h-14 rounded-[14px] bg-white border border-[#E3E7EE] shadow-sm flex items-center justify-center group-hover:border-[#1F4FD8] group-hover:shadow-md transition-all">
                <svg className="w-7 h-7 text-[#1B2433] group-hover:text-[#1F4FD8] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <span className="text-[11px] text-[#1B2433] font-medium text-center leading-tight">Self Transfer</span>
            </button>

            {/* Razorpay Checkout */}
            <button
              type="button"
              onClick={() => onNavigateToSend('razorpay')}
              className={`flex flex-col items-center gap-2 group ${!razorpayConfig?.enabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              disabled={!razorpayConfig?.enabled}
            >
              <div className="w-14 h-14 rounded-[14px] bg-white border border-[#E3E7EE] shadow-sm flex items-center justify-center group-hover:border-[#1F4FD8] group-hover:shadow-md transition-all">
                <svg className="w-7 h-7 text-[#1B2433] group-hover:text-[#1F4FD8] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              </div>
              <span className="text-[11px] text-[#1B2433] font-medium text-center leading-tight">Razorpay</span>
            </button>
          </div>
        </div>

        {/* ─── Quick Actions / Most Popular ─── */}
        <div className="px-4 mt-5 mb-6">
          <h2 className="text-[15px] font-semibold text-[#1B2433] mb-3">Quick Actions</h2>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onBackToDashboard}
              className="bg-white border border-[#E3E7EE] rounded-[12px] p-4 flex items-center gap-3 hover:shadow-sm transition-shadow text-left"
            >
              <div className="w-10 h-10 rounded-[10px] bg-[#EEF3FD] flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-[#1F4FD8]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <div>
                <div className="text-[12px] font-semibold text-[#1B2433]">Dashboard</div>
                <div className="text-[10px] text-[#8A94A6]">Fraud analytics</div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setBottomNav('transactions')}
              className="bg-white border border-[#E3E7EE] rounded-[12px] p-4 flex items-center gap-3 hover:shadow-sm transition-shadow text-left"
            >
              <div className="w-10 h-10 rounded-[10px] bg-[#13805B]/8 flex items-center justify-center flex-shrink-0">
                <svg className="w-5 h-5 text-[#13805B]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <div className="text-[12px] font-semibold text-[#1B2433]">All Payments</div>
                <div className="text-[10px] text-[#8A94A6]">View history</div>
              </div>
            </button>
          </div>
        </div>

      </div>

      {/* Receipt Modal */}
      <PaymentReceiptModal
        receipt={selectedReceipt}
        onClose={() => setSelectedReceipt(null)}
      />

      {/* Bottom Navigation */}
      <BottomNavBar activeTab={bottomNav} onSelectTab={handleBottomNav} />
    </div>
  );
};
