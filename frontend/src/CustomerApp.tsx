import React, { useState } from 'react';
import { PaymentHome } from './components/PaymentHome';
import { SendMoneyView } from './components/SendMoneyView';
import { CustomerNavbar } from './components/CustomerNavbar';

interface CustomerPaySubView {
  view: 'home' | 'send';
  mode?: 'simulated' | 'razorpay';
  autoScan?: boolean;
  selfTransfer?: boolean;
}

export const CustomerApp: React.FC = () => {
  const [subView, setSubView] = useState<CustomerPaySubView>({ view: 'home' });

  const handleNavigateToSend = (
    mode: 'simulated' | 'razorpay',
    options?: { autoScan?: boolean; selfTransfer?: boolean }
  ) => {
    setSubView({
      view: 'send',
      mode,
      autoScan: options?.autoScan,
      selfTransfer: options?.selfTransfer,
    });
  };

  const handleBackToPayHome = () => {
    setSubView({ view: 'home' });
  };

  return (
    <div className="min-h-screen bg-[#F4F5F7] text-[#1B2433] flex flex-col font-sans">
      <CustomerNavbar />

      <main className="flex-1 flex flex-col items-center w-full">
        {subView.view === 'home' ? (
          <PaymentHome onNavigateToSend={handleNavigateToSend} />
        ) : (
          <SendMoneyView
            onBackToPayHome={handleBackToPayHome}
            initialMode={subView.mode}
            autoScan={subView.autoScan}
            selfTransfer={subView.selfTransfer}
            showPinStep={true}
            hideModelScores={true}
          />
        )}
      </main>

      <footer className="w-full py-3 bg-[#F4F5F7] border-t border-[#E3E7EE] text-center text-[11px] text-[#5B6575]">
        Test environment, no real money
      </footer>
    </div>
  );
};

export default CustomerApp;
