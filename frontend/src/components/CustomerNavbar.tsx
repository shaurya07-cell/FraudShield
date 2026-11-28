import React from 'react';

export const CustomerNavbar: React.FC = () => {
  return (
    <header className="w-full bg-[#17202E] border-b border-[#2B3545] sticky top-0 z-30">
      <div className="max-w-[560px] mx-auto px-4 h-12 flex items-center justify-between">
        {/* Brand / Logo */}
        <div className="flex items-center gap-2.5 min-w-0 flex-shrink-0">
          <svg
            className="w-5 h-5 flex-shrink-0 aspect-square"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="4" r="2.25" stroke="#1F4FD8" strokeWidth="2" fill="#17202E" />
            <circle cx="5" cy="18" r="2.25" stroke="#FFFFFF" strokeWidth="1.75" fill="#17202E" />
            <circle cx="19" cy="18" r="2.25" stroke="#FFFFFF" strokeWidth="1.75" fill="#17202E" />
            <path d="M10.2 5.5L6.8 16.2" stroke="#4F5D73" strokeWidth="1.5" />
            <path d="M13.8 5.5L17.2 16.2" stroke="#4F5D73" strokeWidth="1.5" />
            <path d="M7.2 18h9.6" stroke="#1F4FD8" strokeWidth="1.5" />
          </svg>
          <span className="font-semibold text-[15px] tracking-tight text-[#FFFFFF] leading-none whitespace-nowrap">
            FraudShield Pay
          </span>
        </div>

        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-white/10 rounded-full text-white/80 text-[11px] font-medium flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#1E8E5A]" aria-hidden="true" />
          <span>Demo Rail</span>
        </div>
      </div>
    </header>
  );
};
