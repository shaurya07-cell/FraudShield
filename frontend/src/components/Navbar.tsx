import React from 'react';

interface NavbarProps {
  currentTab: 'dashboard' | 'pay';
  onSelectTab: (tab: 'dashboard' | 'pay') => void;
  connectionStatus: 'connected' | 'reconnecting';
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, onSelectTab, connectionStatus }) => {
  const isConnected = connectionStatus === 'connected';

  return (
    <header className="w-full bg-[#FFFFFF] border-b border-[#DCE0E7] sticky top-0 z-30">
      <div className="max-w-[1440px] mx-auto px-3 sm:px-4 h-12 flex items-center justify-between">
        <div className="flex items-center space-x-3 sm:space-x-6">
          {/* Logo */}
          <div className="flex items-center">
            <img src="/logo.png" alt="FraudShield" className="h-7 w-auto object-contain flex-shrink-0" />
          </div>

          {/* Navigation Links */}
          <nav className="flex items-center space-x-1" aria-label="Main Navigation">
            <button
              type="button"
              onClick={() => onSelectTab('dashboard')}
              className={`px-2.5 sm:px-3 py-1 text-[13px] sm:text-[14px] font-medium rounded-[6px] transition-colors ${
                currentTab === 'dashboard'
                  ? 'text-[#1F4FD8] bg-[#F4F5F7]'
                  : 'text-[#5B6575] hover:text-[#1B2433] hover:bg-[#F4F5F7]'
              }`}
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => onSelectTab('pay')}
              className={`px-2.5 sm:px-3 py-1 text-[13px] sm:text-[14px] font-medium rounded-[6px] transition-colors ${
                currentTab === 'pay'
                  ? 'text-[#1F4FD8] bg-[#F4F5F7]'
                  : 'text-[#5B6575] hover:text-[#1B2433] hover:bg-[#F4F5F7]'
              }`}
            >
              Send money
            </button>
          </nav>
        </div>

        {/* Connection status indicator */}
        <div className="flex items-center space-x-1.5 flex-shrink-0" title={isConnected ? 'Connected' : 'Reconnecting'}>
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#1E8E5A]' : 'bg-[#B7791F]'}`}
            aria-hidden="true"
          />
          <span className="text-[12px] text-[#5B6575] hidden sm:inline">
            {isConnected ? 'Connected' : 'Reconnecting'}
          </span>
        </div>
      </div>
    </header>
  );
};
