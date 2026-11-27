import React from 'react';
import type { PaymentReceipt } from '../services/api';

interface PaymentReceiptModalProps {
  receipt: PaymentReceipt | null;
  onClose: () => void;
}

export const PaymentReceiptModal: React.FC<PaymentReceiptModalProps> = ({ receipt, onClose }) => {
  if (!receipt) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#1B2433]/40 flex items-center justify-center p-4">
      <div className="bg-[#FFFFFF] border border-[#E3E7EE] rounded-[8px] max-w-md w-full shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Receipt Header */}
        <div className="p-4 bg-[#F4F5F7] border-b border-[#E3E7EE] flex items-center justify-between">
          <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5">
            <h3 className="text-[14px] font-semibold text-[#1B2433]">Payment receipt</h3>
            <div className="text-[11px] font-mono text-[#8A94A6]">{receipt.receipt_number}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-[#8A94A6] hover:text-[#1B2433] hover:bg-[#E3E7EE]"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-[13px] text-[#1B2433]">
          {/* Amount Badge */}
          <div className="text-center py-2 bg-[#EEF3FD] rounded-[6px] border border-[#1F4FD8]/20">
            <div className="text-[11px] text-[#8A94A6] font-medium">Amount paid</div>
            <div className="text-[26px] font-semibold font-mono text-[#1F4FD8]">
              ₹{receipt.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
            <div className="text-[11px] font-medium text-[#13805B] mt-0.5">
              Status: {receipt.status}
            </div>
          </div>

          {/* Details Table */}
          <div className="divide-y divide-[#E3E7EE] border border-[#E3E7EE] rounded-[6px] text-[12px]">
            <div className="p-2.5 flex justify-between">
              <span className="text-[#8A94A6]">Reference ID</span>
              <span className="font-mono text-[#1B2433] text-[11px] select-all">{receipt.reference_id}</span>
            </div>
            <div className="p-2.5 flex justify-between">
              <span className="text-[#8A94A6]">Payer</span>
              <span className="text-[#1B2433] font-medium">{receipt.payer.name} ({receipt.payer.account_id})</span>
            </div>
            <div className="p-2.5 flex justify-between">
              <span className="text-[#8A94A6]">Payee</span>
              <span className="text-[#1B2433] font-medium">{receipt.payee.name} ({receipt.payee.account_id})</span>
            </div>
            <div className="p-2.5 flex justify-between">
              <span className="text-[#8A94A6]">Date & Time</span>
              <span className="font-mono text-[#1B2433] text-[11px]">
                {new Date(receipt.timestamp).toLocaleString('en-IN', { hour12: false })}
              </span>
            </div>
            <div className="p-2.5 flex justify-between">
              <span className="text-[#8A94A6]">Risk Decision</span>
              <span className="font-mono font-medium text-[#1B2433]">
                {receipt.decision || 'N/A'} (Score {receipt.risk_score}/100)
              </span>
            </div>
          </div>

          <p className="text-[11px] text-[#8A94A6] text-center">
            FraudShield Test Mode Receipt. No real funds were moved or settled.
          </p>

          <button
            type="button"
            onClick={onClose}
            className="w-full py-2 bg-[#1F4FD8] text-[#FFFFFF] font-medium rounded-[6px] hover:bg-[#183EB0] transition-colors"
          >
            Close receipt
          </button>
        </div>
      </div>
    </div>
  );
};
