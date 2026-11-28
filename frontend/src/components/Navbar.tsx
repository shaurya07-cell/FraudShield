import React from 'react';

interface NavbarProps {
  currentTab?: 'dashboard' | 'pay';
  onSelectTab?: (tab: 'dashboard' | 'pay') => void;
  connectionStatus: 'connected' | 'reconnecting';
  showTabs?: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  connectionStatus,
  showTabs = true,
}) => {
  const isConnected = connectionStatus === 'connected';

  return (
    <header className="w-full bg-[#1B2433] border-b border-[#2B3545] sticky top-0 z-30">
      <div className="max-w-[1440px] mx-auto px-3 sm:px-4 h-12 flex items-center justify-between">
        <div className="flex items-center space-x-2 sm:space-x-6 min-w-0">
          {/* Logo & Ring network mark */}
          <div className="flex items-center gap-2 sm:gap-2.5 flex-shrink-0">
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
              <circle cx="12" cy="4" r="2.25" stroke="#1F4FD8" strokeWidth="2" fill="#1B2433" />
              <circle cx="5" cy="18" r="2.25" stroke="#FFFFFF" strokeWidth="1.75" fill="#1B2433" />
              <circle cx="19" cy="18" r="2.25" stroke="#FFFFFF" strokeWidth="1.75" fill="#1B2433" />
              <path d="M10.2 5.5L6.8 16.2" stroke="#4F5D73" strokeWidth="1.5" />
              <path d="M13.8 5.5L17.2 16.2" stroke="#4F5D73" strokeWidth="1.5" />
              <path d="M7.2 18h9.6" stroke="#1F4FD8" strokeWidth="1.5" />
            </svg>
            <span className="font-semibold text-[14px] sm:text-[15px] tracking-tight text-[#FFFFFF] leading-none whitespace-nowrap">
              FraudShield
            </span>
          </div>

          {/* Navigation Links */}
          {showTabs && onSelectTab && currentTab && (
            <nav className="flex items-center space-x-1 flex-shrink-0" aria-label="Main Navigation">
              <button
                type="button"
                onClick={() => onSelectTab('dashboard')}
                className={`px-2.5 sm:px-3 py-1 text-[12px] sm:text-[13px] font-medium rounded-[4px] transition-colors whitespace-nowrap ${
                  currentTab === 'dashboard'
                    ? 'text-[#FFFFFF] bg-[#1F4FD8]'
                    : 'text-[#8A94A6] hover:text-[#FFFFFF] hover:bg-[#2B3545]'
                }`}
              >
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => onSelectTab('pay')}
                className={`px-2.5 sm:px-3 py-1 text-[12px] sm:text-[13px] font-medium rounded-[4px] transition-colors whitespace-nowrap ${
                  currentTab === 'pay'
                    ? 'text-[#FFFFFF] bg-[#1F4FD8]'
                    : 'text-[#8A94A6] hover:text-[#FFFFFF] hover:bg-[#2B3545]'
                }`}
              >
                Send money
              </button>
            </nav>
          )}
        </div>

        {/* Connection status indicator */}
        <div
          className="flex items-center space-x-1.5 sm:space-x-2 flex-shrink-0 ml-2"
          title={isConnected ? 'Connected' : 'Reconnecting'}
        >
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${isConnected ? 'bg-[#13805B]' : 'bg-[#B7791F]'}`}
            aria-hidden="true"
          />
          <span className="text-[12px] text-[#8A94A6] hidden sm:inline whitespace-nowrap">
            {isConnected ? 'Connected' : 'Reconnecting'}
          </span>
        </div>
      </div>
    </header>
  );
};
