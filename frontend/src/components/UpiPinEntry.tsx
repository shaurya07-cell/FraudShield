import React, { useState, useEffect, useCallback } from 'react';

interface UpiPinEntryProps {
  amount?: number;
  payeeName?: string;
  payeeHandle?: string;
  title?: string;
  onSuccess: () => void;
  onCancel: () => void;
}

const CORRECT_PIN = '1122';

export const UpiPinEntry: React.FC<UpiPinEntryProps> = ({
  amount,
  payeeName,
  payeeHandle,
  title,
  onSuccess,
  onCancel,
}) => {
  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const triggerShake = () => {
    setIsShaking(true);
    setTimeout(() => setIsShaking(false), 500);
  };

  const handleDigit = useCallback(
    (digit: string) => {
      setError(null);
      if (pin.length < 4) {
        setPin((prev) => prev + digit);
      }
    },
    [pin.length]
  );

  const handleBackspace = useCallback(() => {
    setError(null);
    setPin((prev) => prev.slice(0, -1));
  }, []);

  const handleClear = useCallback(() => {
    setError(null);
    setPin('');
  }, []);

  const handleSubmit = useCallback(() => {
    if (pin.length !== 4) {
      setError('Please enter your 4-digit PIN');
      triggerShake();
      return;
    }

    if (pin === CORRECT_PIN) {
      setIsSubmitting(true);
      setError(null);
      setPin('');
      onSuccess();
    } else {
      setError(`Incorrect PIN. Test PIN is ${CORRECT_PIN}.`);
      triggerShake();
      setPin('');
    }
  }, [pin, onSuccess]);

  // Support physical keyboard entry
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isSubmitting) return;
      if (/^[0-9]$/.test(e.key)) {
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        handleBackspace();
      } else if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleDigit, handleBackspace, handleSubmit, isSubmitting, onCancel]);

  return (
    <div className="w-full space-y-4">
      {/* Keyframe animation for subtle error shake */}
      <style>{`
        @keyframes subtle-shake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-5px); }
          40%, 80% { transform: translateX(5px); }
        }
        .animate-subtle-shake {
          animation: subtle-shake 0.4s ease-in-out;
        }
      `}</style>

      {/* Paying-to Card or Balance Check Card */}
      {amount !== undefined && payeeName ? (
        <div className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-[10px] p-4 text-center space-y-1 shadow-xs">
          <div className="text-[11px] uppercase tracking-wider text-[#64748B] font-medium">Paying to</div>
          <div className="text-[16px] font-semibold text-[#0F172A]">{payeeName}</div>
          <div className="text-[12px] font-mono text-[#64748B]">{payeeHandle}</div>
          <div className="text-[28px] font-bold font-mono text-[#0F172A] pt-1 tabular-nums tracking-tight">
            ₹{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
      ) : (
        <div className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-[10px] p-4 text-center space-y-1 shadow-xs">
          <div className="text-[11px] uppercase tracking-wider text-[#64748B] font-medium">Security Authentication</div>
          <div className="text-[16px] font-semibold text-[#0F172A]">{title || 'Check Account Balance'}</div>
          <div className="text-[12px] text-[#64748B]">Enter your PIN to view available funds</div>
        </div>
      )}

      {/* PIN Prompt & Animated Dots Section */}
      <div className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-[10px] p-5 text-center space-y-3.5 shadow-xs">
        <div className="text-[13px] font-semibold text-[#0F172A] tracking-tight">
          Enter your PIN
        </div>

        {/* 4 Masked Dots with smooth spring-like animation */}
        <div
          className={`flex items-center justify-center gap-4 py-2 ${isShaking ? 'animate-subtle-shake' : ''}`}
          aria-label="PIN entry field"
        >
          {[0, 1, 2, 3].map((idx) => {
            const isFilled = pin.length > idx;
            return (
              <div
                key={idx}
                className={`w-4 h-4 rounded-full transition-all duration-200 ease-out flex items-center justify-center ${
                  isFilled
                    ? 'bg-[#0F172A] scale-110 shadow-xs'
                    : 'border-2 border-[#CBD5E1] bg-transparent scale-100'
                }`}
              >
                {isFilled && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white/40 block" />
                )}
              </div>
            );
          })}
        </div>

        {/* Quiet Sandbox Disclosure */}
        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#F1F5F9] border border-[#E2E8F0] rounded-full text-[11px] text-[#475569] font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-[#3B82F6]" aria-hidden="true" />
          <span>Sandbox payment — no real funds move. Test PIN: {CORRECT_PIN}</span>
        </div>

        {/* Error message */}
        {error && (
          <div className="text-[12px] font-medium text-[#DC2626] pt-0.5">
            {error}
          </div>
        )}
      </div>

      {/* Polished On-Screen Numeric Keypad */}
      <div className="bg-[#FFFFFF] border border-[#E2E8F0] rounded-[12px] p-3 shadow-xs">
        <div className="grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              type="button"
              disabled={isSubmitting}
              onClick={() => handleDigit(d)}
              className="min-h-[52px] sm:min-h-[56px] rounded-[9px] bg-[#F8FAFC] hover:bg-[#F1F5F9] active:bg-[#E2E8F0] active:scale-[0.96] border border-[#E2E8F0]/80 text-[20px] font-semibold text-[#0F172A] transition-all duration-100 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-[#1F4FD8]/30 shadow-2xs select-none"
            >
              {d}
            </button>
          ))}

          {/* Bottom row: Clear, 0, Backspace */}
          <button
            type="button"
            disabled={isSubmitting || pin.length === 0}
            onClick={handleClear}
            className="min-h-[52px] sm:min-h-[56px] rounded-[9px] bg-[#F8FAFC] hover:bg-[#F1F5F9] active:bg-[#E2E8F0] active:scale-[0.96] border border-[#E2E8F0]/80 text-[12px] font-medium text-[#64748B] transition-all duration-100 flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none select-none"
          >
            Clear
          </button>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleDigit('0')}
            className="min-h-[52px] sm:min-h-[56px] rounded-[9px] bg-[#F8FAFC] hover:bg-[#F1F5F9] active:bg-[#E2E8F0] active:scale-[0.96] border border-[#E2E8F0]/80 text-[20px] font-semibold text-[#0F172A] transition-all duration-100 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-[#1F4FD8]/30 shadow-2xs select-none"
          >
            0
          </button>

          <button
            type="button"
            disabled={isSubmitting || pin.length === 0}
            onClick={handleBackspace}
            aria-label="Backspace"
            className="min-h-[52px] sm:min-h-[56px] rounded-[9px] bg-[#F8FAFC] hover:bg-[#F1F5F9] active:bg-[#E2E8F0] active:scale-[0.96] border border-[#E2E8F0]/80 text-[#64748B] transition-all duration-100 flex items-center justify-center disabled:opacity-30 disabled:pointer-events-none select-none"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Action Buttons: Cancel vs Submit */}
      <div className="flex gap-2.5 pt-1">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={onCancel}
          className="w-1/3 min-h-[44px] py-2.5 px-3 border border-[#E2E8F0] bg-white text-[#475569] text-[13px] font-medium rounded-[8px] hover:bg-[#F8FAFC] active:scale-[0.98] transition-all duration-100"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isSubmitting || pin.length !== 4}
          onClick={handleSubmit}
          className="flex-1 min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[8px] hover:bg-[#183EB0] active:scale-[0.98] disabled:bg-[#CBD5E1] disabled:text-[#94A3B8] disabled:cursor-not-allowed transition-all duration-100 flex items-center justify-center gap-1.5 shadow-xs"
        >
          {isSubmitting ? (
            <span>Verifying...</span>
          ) : (
            <>
              <span>{amount !== undefined ? 'Authorize Payment' : 'Reveal Balance'}</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
