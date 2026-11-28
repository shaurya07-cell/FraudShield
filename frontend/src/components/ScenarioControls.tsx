import React from 'react';

interface ScenarioControlsProps {
  onRunScenario: (scenario: string, label: string) => void;
  onReset: () => void;
  isRunning: boolean;
  statusMessage: string | null;
}

export const ScenarioControls: React.FC<ScenarioControlsProps> = ({
  onRunScenario,
  onReset,
  isRunning,
  statusMessage,
}) => {
  return (
    <div className="w-full bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] p-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5 mr-2 flex items-center gap-2">
            <span className="text-[14px] font-semibold text-[#1B2433]">Run scenario</span>
            <span className="text-[11px] text-[#5B6575] bg-[#F4F5F7] border border-[#DCE0E7] px-1.5 py-0.5 rounded-[4px] font-normal">
              Synthetic traffic
            </span>
          </div>

          <button
            type="button"
            disabled={isRunning}
            onClick={() => onRunScenario('normal', 'Normal traffic')}
            className="px-3 py-1.5 min-h-[44px] text-[14px] font-medium text-[#1B2433] bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] hover:bg-[#F4F5F7] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Normal traffic
          </button>

          <button
            type="button"
            disabled={isRunning}
            onClick={() => onRunScenario('velocity_attack', 'Velocity attack')}
            className="px-3 py-1.5 min-h-[44px] text-[14px] font-medium text-[#1B2433] bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] hover:bg-[#F4F5F7] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Velocity attack
          </button>

          <button
            type="button"
            disabled={isRunning}
            onClick={() => onRunScenario('ring_attack', 'Ring attack')}
            className="px-3 py-1.5 min-h-[44px] text-[14px] font-medium text-[#1B2433] bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] hover:bg-[#F4F5F7] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Ring attack
          </button>

          <button
            type="button"
            disabled={isRunning}
            onClick={() => onRunScenario('fanout_cashout', 'Fan-out cash-out')}
            className="px-3 py-1.5 min-h-[44px] text-[14px] font-medium text-[#1B2433] bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] hover:bg-[#F4F5F7] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Fan-out cash-out
          </button>

          <button
            type="button"
            disabled={isRunning}
            onClick={() => onRunScenario('bulk_payer', 'Bulk payer')}
            className="px-3 py-1.5 min-h-[44px] text-[14px] font-medium text-[#1B2433] bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] hover:bg-[#F4F5F7] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Bulk payer
          </button>

          <button
            type="button"
            disabled={isRunning}
            onClick={onReset}
            className="px-3 py-1.5 text-[14px] font-medium text-[#5B6575] hover:text-[#C0362C] hover:bg-[#F4F5F7] rounded-[6px] disabled:opacity-50 disabled:cursor-not-allowed transition-colors ml-1"
          >
            Reset
          </button>
        </div>

        {/* Inline status line */}
        <div className="text-[13px] text-[#5B6575] tabular-nums min-h-[20px] flex items-center">
          {isRunning && (
            <span className="inline-block w-2 h-2 rounded-full bg-[#1F4FD8] animate-pulse mr-2" />
          )}
          {statusMessage ? <span>{statusMessage}</span> : <span>Ready</span>}
        </div>
      </div>

      <div className="mt-2 text-[12px] text-[#5B6575]">
        Bulk payer is a hard case: a new account paying many people looks like a cash-out. The system flags it for review.
      </div>
    </div>
  );
};
