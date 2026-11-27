import React, { useEffect, useRef } from 'react';
import type { ScoredTransaction } from '../types/fraud';

interface TransactionDrawerProps {
  transaction: ScoredTransaction | null;
  onClose: () => void;
}

export const TransactionDrawer: React.FC<TransactionDrawerProps> = ({ transaction, onClose }) => {
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  // Close on Escape key press
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (transaction) {
      window.addEventListener('keydown', handleKeyDown);
      closeBtnRef.current?.focus();
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [transaction, onClose]);

  if (!transaction) return null;

  const getDecisionBadge = (decision: string) => {
    if (decision === 'ALLOW') {
      return (
        <span className="inline-block px-2.5 py-1 text-[12px] font-medium rounded-[4px] bg-[#1E8E5A]/10 text-[#1E8E5A]">
          Allow
        </span>
      );
    }
    if (decision === 'REVIEW') {
      return (
        <span className="inline-block px-2.5 py-1 text-[12px] font-medium rounded-[4px] bg-[#B7791F]/10 text-[#B7791F]">
          Review
        </span>
      );
    }
    return (
      <span className="inline-block px-2.5 py-1 text-[12px] font-medium rounded-[4px] bg-[#C0362C]/10 text-[#C0362C]">
        Block
      </span>
    );
  };

  const formatAmount = (amt: number) => {
    return `₹${amt.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-[#1B2433]/20 flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
    >
      <div
        className="w-full max-w-[420px] bg-[#FFFFFF] h-full border-l border-[#DCE0E7] p-6 overflow-y-auto flex flex-col justify-between"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-[#DCE0E7]">
            <h2 id="drawer-title" className="text-[16px] font-medium text-[#1B2433]">
              Transaction details
            </h2>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label="Close details"
              className="p-1 rounded-[4px] text-[#5B6575] hover:text-[#1B2433] hover:bg-[#F4F5F7] transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Key metrics header */}
          <div className="py-4 border-b border-[#DCE0E7] flex items-center justify-between">
            <div>
              <div className="text-[12px] text-[#5B6575] mb-1">Decision & score</div>
              <div className="flex items-center space-x-3">
                {getDecisionBadge(transaction.decision)}
                <span className="text-[24px] font-semibold text-[#1B2433] tabular-nums leading-tight">
                  {transaction.risk_score}
                </span>
                <span className="text-[12px] text-[#5B6575]">/ 100</span>
              </div>
            </div>

            <div className="text-right">
              <div className="text-[12px] text-[#5B6575] mb-1">Latency</div>
              <div className="text-[18px] font-semibold text-[#1B2433] tabular-nums">
                {transaction.latency_ms.toFixed(1)} <span className="text-[12px] font-normal text-[#5B6575]">ms</span>
              </div>
            </div>
          </div>

          {/* Core attributes */}
          <div className="py-4 border-b border-[#DCE0E7] space-y-3 text-[13px]">
            <div>
              <div className="text-[12px] text-[#5B6575]">Transaction ID</div>
              <div className="font-mono text-[#1B2433] mt-0.5 select-all">{transaction.txn_id}</div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-[12px] text-[#5B6575]">From account</div>
                <div className="font-mono text-[#1B2433] mt-0.5 font-medium">{transaction.sender_id}</div>
              </div>
              <div>
                <div className="text-[12px] text-[#5B6575]">To account</div>
                <div className="font-mono text-[#1B2433] mt-0.5 font-medium">{transaction.receiver_id}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-[12px] text-[#5B6575]">Amount</div>
                <div className="font-medium text-[#1B2433] mt-0.5 tabular-nums">{formatAmount(transaction.amount)}</div>
              </div>
              <div>
                <div className="text-[12px] text-[#5B6575]">Timestamp</div>
                <div className="text-[#1B2433] mt-0.5 tabular-nums text-[12px]">{transaction.timestamp}</div>
              </div>
            </div>

            {transaction.ring_id && (
              <div className="p-2.5 rounded-[4px] bg-[#C0362C]/10 border border-[#C0362C]/20">
                <div className="text-[12px] font-medium text-[#C0362C]">Associated fraud ring</div>
                <div className="font-mono text-[#C0362C] font-semibold mt-0.5 text-[13px]">{transaction.ring_id}</div>
              </div>
            )}
          </div>

          {/* Risk reasons */}
          <div className="py-4">
            <h3 className="text-[14px] font-medium text-[#1B2433] mb-3">Evaluated risk factors</h3>
            {transaction.reasons.length === 0 ? (
              <div className="text-[13px] text-[#5B6575]">
                No abnormal risk factors detected. Standard legitimate baseline.
              </div>
            ) : (
              <div className="space-y-2.5">
                {transaction.reasons.map((reason, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-[#F4F5F7] border border-[#DCE0E7] rounded-[6px] text-[13px]"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-[#1B2433]">{reason.rule}</span>
                      <span className="text-[12px] text-[#5B6575] tabular-nums">
                        Weight <span className="font-semibold text-[#1B2433]">{reason.weight}</span>
                      </span>
                    </div>
                    <div className="text-[#5B6575] leading-relaxed text-[12px] max-w-[80ch]">
                      {reason.detail}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-4 border-t border-[#DCE0E7]">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2 px-4 text-[14px] font-medium text-[#1B2433] bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
