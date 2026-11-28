import React from 'react';
import type { ScoredTransaction } from '../types/fraud';
import { DecisionBadge } from './DecisionBadge';

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

  const shortId = (id: string) => (id && id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-3)}` : id);

  return (
    <div className="w-full bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] p-4 flex flex-col h-full">
      <div className="flex items-center justify-between pb-3 border-b border-[#E3E7EE] mb-2">
        <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5">
          <h2 className="text-[15px] font-semibold text-[#1B2433]">Live feed</h2>
        </div>
        <span className="text-[12px] text-[#8A94A6] font-mono tabular-nums">
          {transactions.length} recent
        </span>
      </div>

      <div className="overflow-x-auto flex-1 max-h-[730px] overflow-y-auto">
        <table className="w-full min-w-[420px] text-left text-[13px] border-collapse">
          <thead className="sticky top-0 bg-[#F4F5F7] z-10 border-b border-[#E3E7EE]">
            <tr className="text-[#8A94A6] text-[11px] font-medium">
              <th className="py-2.5 px-2 w-[70px]">Time</th>
              <th className="py-2.5 px-2 w-[85px]">From</th>
              <th className="py-2.5 px-2 w-[85px]">To</th>
              <th className="py-2.5 px-2 text-right w-[80px]">Amount</th>
              <th className="py-2.5 px-2 text-center w-[50px]">Risk</th>
              <th className="py-2.5 px-2 text-right w-[70px]">Decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E3E7EE]">
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-[#8A94A6] text-[13px]">
                  No transactions yet. Run a scenario to see activity.
                </td>
              </tr>
            ) : (
              transactions.map((txn, idx) => {
                const isSelected = selectedTxn?.txn_id === txn.txn_id;
                const isNew = txn.isNew;
                const zebraBg = idx % 2 === 1 ? 'bg-[#F4F5F7]/30' : 'bg-[#FFFFFF]';

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
                      isSelected ? 'bg-[#EEF3FD]' : `${zebraBg} hover:bg-[#EEF3FD]/60`
                    } ${isNew ? 'animate-row-new' : ''}`}
                  >
                    <td className="py-2 px-2 text-[#8A94A6] font-mono tabular-nums text-[11px] whitespace-nowrap">
                      {formatTime(txn.timestamp)}
                    </td>
                    <td className="py-2 px-2 font-mono text-[#1B2433] text-[12px] truncate max-w-[85px]" title={txn.sender_id}>
                      {shortId(txn.sender_id)}
                    </td>
                    <td className="py-2 px-2 font-mono text-[#1B2433] text-[12px] truncate max-w-[85px]" title={txn.receiver_id}>
                      {shortId(txn.receiver_id)}
                    </td>
                    <td className="py-2 px-2 text-right font-medium font-mono tabular-nums text-[#1B2433] whitespace-nowrap text-[12px]">
                      {formatAmount(txn.amount)}
                    </td>
                    <td className="py-2 px-2 text-center font-mono tabular-nums font-medium text-[#1B2433] text-[12px]">
                      {txn.risk_score}
                    </td>
                    <td className="py-2 px-2 text-right whitespace-nowrap">
                      <DecisionBadge decision={txn.decision} />
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
