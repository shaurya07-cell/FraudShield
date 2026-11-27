import React from 'react';

export interface StepItem {
  id: string;
  label: string;
}

interface StepperProps {
  steps: StepItem[];
  currentStepIndex: number;
}

export const Stepper: React.FC<StepperProps> = ({ steps, currentStepIndex }) => {
  return (
    <div className="w-full py-2">
      <div className="flex items-center justify-between relative">
        {/* Background connecting line */}
        <div className="absolute left-4 right-4 top-1/2 -translate-y-1/2 h-[2px] bg-[#E3E7EE] -z-0" />

        {steps.map((step, idx) => {
          const isCompleted = idx < currentStepIndex;
          const isActive = idx === currentStepIndex;

          return (
            <div key={step.id} className="relative z-10 flex flex-col items-center bg-white px-2">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-mono transition-colors ${
                  isActive
                    ? 'bg-[#1F4FD8] text-white font-semibold'
                    : isCompleted
                    ? 'bg-[#1F4FD8] text-white'
                    : 'bg-[#F4F5F7] text-[#8A94A6] border border-[#E3E7EE]'
                }`}
              >
                {isCompleted ? (
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <span>{idx + 1}</span>
                )}
              </div>
              <span
                className={`mt-1.5 text-[11px] whitespace-nowrap ${
                  isActive
                    ? 'font-medium text-[#1B2433]'
                    : isCompleted
                    ? 'text-[#1B2433]'
                    : 'text-[#8A94A6]'
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
