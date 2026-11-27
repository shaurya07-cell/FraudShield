import React from 'react';
import type { Decision } from '../types/fraud';

interface DecisionBadgeProps {
  decision: Decision | string | null | undefined;
  score?: number | null;
  className?: string;
}

export const DecisionBadge: React.FC<DecisionBadgeProps> = ({ decision, score, className = '' }) => {
  if (!decision) {
    return <span className={`text-[#5B6575] font-mono text-[11px] ${className}`}>—</span>;
  }

  const d = String(decision).toUpperCase();
  let badgeStyle = 'bg-[#5B6575]/10 text-[#5B6575] border-[#5B6575]/20';
  let label = 'Unknown';

  if (d === 'ALLOW') {
    badgeStyle = 'bg-[#1E8E5A]/10 text-[#1E8E5A] border-[#1E8E5A]/20';
    label = 'Allow';
  } else if (d === 'REVIEW') {
    badgeStyle = 'bg-[#B7791F]/10 text-[#B7791F] border-[#B7791F]/20';
    label = 'Review';
  } else if (d === 'BLOCK') {
    badgeStyle = 'bg-[#C0362C]/10 text-[#C0362C] border-[#C0362C]/20';
    label = 'Block';
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-[4px] border ${badgeStyle} ${className}`}
    >
      <span>{label}</span>
      {score !== undefined && score !== null && (
        <span className="font-mono text-[10px] tabular-nums opacity-90">({score})</span>
      )}
    </span>
  );
};
