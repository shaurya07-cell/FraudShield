import React, { useState, useEffect, useCallback } from 'react';

interface UpiPinEntryProps {
  amount: number;
  payeeName: string;
  payeeHandle: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export const UpiPinEntry: React.FC<UpiPinEntryProps> = ({
  amount,
  payeeName,
  payeeHandle,
  onSuccess,
  onCancel,
}) => {
  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

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
      setError('Please enter a 4-digit PIN');
      return;
    }

    if (pin === '1234') {
      setIsSubmitting(true);
      setError(null);
      // Immediately clear sensitive pin from state before triggering callback
      setPin('');
      onSuccess();
    } else {
      setError('Incorrect demo PIN');
      setPin('');
    }
  }, [pin, onSuccess]);

  // Support physical keyboard entry as well
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
    <div className="w-full space-y-5">
      {/* Disclaimer Banner - ALWAYS VISIBLE */}
      <div className="p-3 bg-[#FFF8E6] border border-[#F5C26B] rounded-[8px] flex items-start gap-2.5">
        <svg
          className="w-4 h-4 text-[#B26B00] flex-shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <div className="text-[12px] text-[#7A4B00] leading-snug">
          <span className="font-semibold">Simulated PIN step.</span> Demo PIN is{' '}
          <span className="font-mono font-bold text-[#1B2433]">1234</span>. Never enter your real UPI PIN here.
        </div>
      </div>

      {/* Transfer Summary Header */}
      <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[8px] p-4 text-center space-y-1 shadow-2xs">
        <div className="text-[11px] uppercase tracking-wider text-[#5B6575] font-medium">Paying to</div>
        <div className="text-[15px] font-semibold text-[#1B2433]">{payeeName}</div>
        <div className="text-[12px] font-mono text-[#5B6575]">{payeeHandle}</div>
        <div className="text-[26px] font-bold font-mono text-[#1B2433] pt-1 tabular-nums">
          ₹{amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>

      {/* 4 Masked Dots Section */}
      <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[8px] p-5 text-center space-y-3 shadow-2xs">
        <div className="text-[12px] font-medium text-[#5B6575]">
          ENTER 4-DIGIT DEMO PIN
        </div>

        <div className="flex items-center justify-center gap-4 py-2" aria-label="PIN Digits">
          {[0, 1, 2, 3].map((idx) => {
            const isFilled = pin.length > idx;
            return (
              <div
                key={idx}
                className={`w-4 h-4 rounded-full transition-all duration-150 ${
                  isFilled
                    ? 'bg-[#1F4FD8] scale-110 shadow-xs'
                    : 'border-2 border-[#A8B2C1] bg-transparent'
                }`}
              />
            );
          })}
        </div>

        {/* Error message */}
        {error && (
          <div className="text-[12px] font-medium text-[#C0362C] animate-shake">
            {error}
          </div>
        )}
      </div>

      {/* On-Screen Numeric Keypad */}
      <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[10px] p-3 shadow-2xs">
        <div className="grid grid-cols-3 gap-2">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button
              key={d}
              type="button"
              disabled={isSubmitting}
              onClick={() => handleDigit(d)}
              className="min-h-[50px] sm:min-h-[54px] rounded-[8px] bg-[#F8F9FA] hover:bg-[#EEF3FD] active:bg-[#DCE7FB] border border-[#E3E7EE] text-[18px] sm:text-[20px] font-semibold text-[#1B2433] transition-colors focus:outline-none focus:ring-2 focus:ring-[#1F4FD8]/40"
            >
              {d}
            </button>
          ))}

          {/* Bottom row: Clear, 0, Backspace */}
          <button
            type="button"
            disabled={isSubmitting || pin.length === 0}
            onClick={handleClear}
            className="min-h-[50px] sm:min-h-[54px] rounded-[8px] bg-[#F8F9FA] hover:bg-[#F1F3F5] active:bg-[#E9ECEF] border border-[#E3E7EE] text-[12px] sm:text-[13px] font-medium text-[#5B6575] transition-colors disabled:opacity-40"
          >
            Clear
          </button>

          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleDigit('0')}
            className="min-h-[50px] sm:min-h-[54px] rounded-[8px] bg-[#F8F9FA] hover:bg-[#EEF3FD] active:bg-[#DCE7FB] border border-[#E3E7EE] text-[18px] sm:text-[20px] font-semibold text-[#1B2433] transition-colors focus:outline-none focus:ring-2 focus:ring-[#1F4FD8]/40"
          >
            0
          </button>

          <button
            type="button"
            disabled={isSubmitting || pin.length === 0}
            onClick={handleBackspace}
            aria-label="Backspace"
            className="min-h-[50px] sm:min-h-[54px] rounded-[8px] bg-[#F8F9FA] hover:bg-[#F1F3F5] active:bg-[#E9ECEF] border border-[#E3E7EE] flex items-center justify-center text-[#5B6575] transition-colors disabled:opacity-40"
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
          className="w-1/3 min-h-[44px] py-2.5 px-3 border border-[#DCE0E7] text-[#1B2433] text-[13px] font-medium rounded-[6px] hover:bg-[#F4F5F7] transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isSubmitting || pin.length !== 4}
          onClick={handleSubmit}
          className="flex-1 min-h-[44px] py-2.5 px-4 bg-[#1F4FD8] text-[#FFFFFF] text-[14px] font-medium rounded-[6px] hover:bg-[#183EB0] disabled:bg-[#D5DAE1] disabled:text-[#5E6B7D] disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5 shadow-2xs"
        >
          {isSubmitting ? (
            <span>Authorizing...</span>
          ) : (
            <>
              <span>Submit PIN</span>
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
