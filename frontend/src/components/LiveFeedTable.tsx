import React from 'react';
import type { ScoredTransaction } from '../types/fraud';

interface LiveFeedTableProps {
  transactions: ScoredTransaction[];
  selectedTxn: ScoredTransaction | null;
  onSelectTxn: (txn: ScoredTransaction) => void;
}

export const LiveFeedTable: React.FC<LiveFeedTableProps> = ({
  transactions,
  selectedTxn,
  onSelectTxn,
}) => {
  const formatTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const formatAmount = (amt: number) => {
    return `₹${amt.toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  };

  const getDecisionBadge = (decision: string) => {
    if (decision === 'ALLOW') {
      return (
        <span className="inline-block px-1.5 py-0.5 text-[11px] font-medium rounded-[4px] bg-[#1E8E5A]/10 text-[#1E8E5A]">
          Allow
        </span>
      );
    }
    if (decision === 'REVIEW') {
      return (
        <span className="inline-block px-1.5 py-0.5 text-[11px] font-medium rounded-[4px] bg-[#B7791F]/10 text-[#B7791F]">
          Review
        </span>
      );
    }
    return (
      <span className="inline-block px-1.5 py-0.5 text-[11px] font-medium rounded-[4px] bg-[#C0362C]/10 text-[#C0362C]">
        Block
      </span>
    );
  };

  return (
    <div className="w-full bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-4 flex flex-col h-full">
      <div className="flex items-center justify-between pb-3 border-b border-[#DCE0E7] mb-2">
        <h2 className="text-[16px] font-medium text-[#1B2433]">Live feed</h2>
        <span className="text-[12px] text-[#5B6575] tabular-nums">
          {transactions.length} recent
        </span>
      </div>

      <div className="overflow-x-auto flex-1 max-h-[730px] overflow-y-auto">
        <table className="w-full text-left text-[13px] border-collapse">
          <thead className="sticky top-0 bg-[#FFFFFF] z-10">
            <tr className="border-b border-[#DCE0E7] text-[#5B6575] text-[12px]">
              <th className="py-2 pr-1 font-normal w-[65px]">Time</th>
              <th className="py-2 px-1 font-normal w-[80px]">From</th>
              <th className="py-2 px-1 font-normal w-[80px]">To</th>
              <th className="py-2 px-1 font-normal text-right w-[75px]">Amount</th>
              <th className="py-2 px-1 font-normal text-center w-[45px]">Risk</th>
              <th className="py-2 pl-1 font-normal text-right w-[60px]">Decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#DCE0E7]">
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-[#5B6575] text-[13px]">
                  No transactions yet. Run a scenario to see activity.
                </td>
              </tr>
            ) : (
              transactions.map((txn) => {
                const isSelected = selectedTxn?.txn_id === txn.txn_id;
                const isNew = txn.isNew;

                return (
                  <tr
                    key={txn.txn_id}
                    onClick={() => onSelectTxn(txn)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelectTxn(txn);
                      }
                    }}
                    className={`cursor-pointer transition-colors ${
                      isSelected ? 'bg-[#F4F5F7]' : 'hover:bg-[#F4F5F7]'
                    } ${isNew ? 'animate-row-new' : ''}`}
                  >
                    <td className="py-2 pr-1 text-[#5B6575] tabular-nums text-[11px] whitespace-nowrap">
                      {formatTime(txn.timestamp)}
                    </td>
                    <td className="py-2 px-1 font-mono text-[#1B2433] text-[12px] truncate max-w-[80px]" title={txn.sender_id}>
                      {txn.sender_id}
                    </td>
                    <td className="py-2 px-1 font-mono text-[#1B2433] text-[12px] truncate max-w-[80px]" title={txn.receiver_id}>
                      {txn.receiver_id}
                    </td>
                    <td className="py-2 px-1 text-right font-medium tabular-nums text-[#1B2433] whitespace-nowrap text-[12px]">
                      {formatAmount(txn.amount)}
                    </td>
                    <td className="py-2 px-1 text-center tabular-nums font-medium text-[#1B2433] text-[12px]">
                      {txn.risk_score}
                    </td>
                    <td className="py-2 pl-1 text-right whitespace-nowrap">
                      {getDecisionBadge(txn.decision)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
