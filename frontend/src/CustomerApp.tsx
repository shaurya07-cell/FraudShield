import React, { useState } from 'react';
import { PaymentHome } from './components/PaymentHome';
import { SendMoneyView } from './components/SendMoneyView';
import { CustomerNavbar } from './components/CustomerNavbar';
import { UpiPinEntry } from './components/UpiPinEntry';

interface CustomerPaySubView {
  view: 'home' | 'send';
  mode?: 'simulated' | 'razorpay';
  autoScan?: boolean;
  selfTransfer?: boolean;
}

export const CustomerApp: React.FC = () => {
  const [subView, setSubView] = useState<CustomerPaySubView>({ view: 'home' });
  const [isBalanceUnlocked, setIsBalanceUnlocked] = useState<boolean>(false);
  const [showBalancePinModal, setShowBalancePinModal] = useState<boolean>(false);

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
          <PaymentHome
            onNavigateToSend={handleNavigateToSend}
            isBalanceUnlocked={isBalanceUnlocked}
            onRequireBalancePin={() => setShowBalancePinModal(true)}
            onMaskBalance={() => setIsBalanceUnlocked(false)}
          />
        ) : (
          <SendMoneyView
            onBackToPayHome={handleBackToPayHome}
            initialMode={subView.mode}
            autoScan={subView.autoScan}
            selfTransfer={subView.selfTransfer}
            showPinStep={true}
            hideModelScores={true}
            isBalanceUnlocked={isBalanceUnlocked}
            onRequireBalancePin={() => setShowBalancePinModal(true)}
            onMaskBalance={() => setIsBalanceUnlocked(false)}
          />
        )}
      </main>

      {/* Balance Verification Modal */}
      {showBalancePinModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-[14px] p-5 max-w-[420px] w-full shadow-2xl border border-[#DCE0E7]">
            <UpiPinEntry
              title="Verify PIN to View Balance"
              onSuccess={() => {
                setIsBalanceUnlocked(true);
                setShowBalancePinModal(false);
              }}
              onCancel={() => setShowBalancePinModal(false)}
            />
          </div>
        </div>
      )}

      <footer className="w-full py-3 bg-[#F4F5F7] border-t border-[#E3E7EE] text-center text-[11px] text-[#5B6575]">
        Sandbox payment — no real funds move.
      </footer>
    </div>
  );
};

export default CustomerApp;
