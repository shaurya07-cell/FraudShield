import React from 'react';
import type { OperationalMetrics } from '../types/fraud';

interface MetricsStripProps {
  metrics: OperationalMetrics;
}

export const MetricsStrip: React.FC<MetricsStripProps> = ({ metrics }) => {
  return (
    <div className="w-full bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] overflow-hidden">
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 divide-x divide-y sm:divide-y-0 divide-[#DCE0E7]">
        {/* 1. Transactions */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Transactions</div>
          <div className="text-[24px] font-semibold text-[#1B2433] tabular-nums leading-tight my-1">
            {metrics.total_txns.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 2. Average latency */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Average latency</div>
          <div className="text-[24px] font-semibold text-[#1B2433] tabular-nums leading-tight my-1">
            {metrics.avg_latency_ms.toFixed(1)} <span className="text-[14px] font-normal text-[#5B6575]">ms</span>
          </div>
          <div className="text-[11px] text-[#5B6575]">limit 100 ms</div>
        </div>

        {/* 3. p99 latency */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">p99 latency</div>
          <div className="text-[24px] font-semibold text-[#1B2433] tabular-nums leading-tight my-1">
            {metrics.p99_latency_ms.toFixed(1)} <span className="text-[14px] font-normal text-[#5B6575]">ms</span>
          </div>
          <div className="text-[11px] text-[#5B6575]">limit 100 ms</div>
        </div>

        {/* 4. Throughput (txn/s) */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Throughput (txn/s)</div>
          <div className="text-[24px] font-semibold text-[#1B2433] tabular-nums leading-tight my-1">
            {metrics.tps.toFixed(1)}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 5. Allowed */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Allowed</div>
          <div className="text-[24px] font-semibold text-[#1E8E5A] tabular-nums leading-tight my-1">
            {metrics.allowed.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 6. Review */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Review</div>
          <div className="text-[24px] font-semibold text-[#B7791F] tabular-nums leading-tight my-1">
            {metrics.review.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 7. Blocked */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Blocked</div>
          <div className="text-[24px] font-semibold text-[#C0362C] tabular-nums leading-tight my-1">
            {metrics.blocked.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 8. Rings detected */}
        <div className="p-3.5 flex flex-col justify-between">
          <div className="text-[12px] text-[#5B6575]">Rings detected</div>
          <div className="text-[24px] font-semibold text-[#C0362C] tabular-nums leading-tight my-1">
            {metrics.rings_detected.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};
