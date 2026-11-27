import React from 'react';
import type { OperationalMetrics } from '../types/fraud';

interface MetricsStripProps {
  metrics: OperationalMetrics;
}

export const MetricsStrip: React.FC<MetricsStripProps> = ({ metrics }) => {
  const totalDecisions = metrics.allowed + metrics.review + metrics.blocked;
  const allowPct = totalDecisions > 0 ? (metrics.allowed / totalDecisions) * 100 : 0;
  const reviewPct = totalDecisions > 0 ? (metrics.review / totalDecisions) * 100 : 0;
  const blockPct = totalDecisions > 0 ? (metrics.blocked / totalDecisions) * 100 : 0;

  return (
    <div className="w-full bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] overflow-hidden">
      {/* Decision Rail */}
      <div className="px-4 py-2.5 bg-[#F4F5F7]/80 border-b border-[#E3E7EE] flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[#1B2433]">Decisions</span>
          <span className="text-[#8A94A6] font-mono tabular-nums text-[11px]">
            {totalDecisions > 0 ? `${totalDecisions.toLocaleString()} processed` : 'No transactions'}
          </span>
        </div>

        {/* Rail Bar & Legend */}
        <div className="flex items-center gap-3 flex-1 sm:max-w-md">
          <div className="w-full h-1.5 bg-[#E3E7EE] rounded-full overflow-hidden flex">
            {totalDecisions > 0 ? (
              <>
                <div style={{ width: `${allowPct}%` }} className="bg-[#13805B] h-full" title={`Allow: ${metrics.allowed}`} />
                <div style={{ width: `${reviewPct}%` }} className="bg-[#B7791F] h-full" title={`Review: ${metrics.review}`} />
                <div style={{ width: `${blockPct}%` }} className="bg-[#C53030] h-full" title={`Block: ${metrics.blocked}`} />
              </>
            ) : (
              <div className="w-full h-full bg-[#E3E7EE]" />
            )}
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums flex-shrink-0">
            <span className="text-[#13805B] font-medium">{metrics.allowed}</span>
            <span className="text-[#8A94A6]">/</span>
            <span className="text-[#B7791F] font-medium">{metrics.review}</span>
            <span className="text-[#8A94A6]">/</span>
            <span className="text-[#C53030] font-medium">{metrics.blocked}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 divide-x divide-y sm:divide-y-0 divide-[#E3E7EE]">
        {/* 1. Transactions */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#1F4FD8]">
          <div className="text-[12px] text-[#8A94A6]">Transactions</div>
          <div className="text-[24px] font-semibold text-[#1B2433] font-mono tabular-nums leading-tight my-1">
            {metrics.total_txns.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 2. Average latency */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#0E9F8E]">
          <div className="text-[12px] text-[#8A94A6]">Average latency</div>
          <div className="text-[24px] font-semibold text-[#1B2433] font-mono tabular-nums leading-tight my-1">
            {metrics.avg_latency_ms.toFixed(1)} <span className="text-[14px] font-normal text-[#8A94A6]">ms</span>
          </div>
          <div className="text-[11px] text-[#8A94A6]">limit 100 ms</div>
        </div>

        {/* 3. p99 latency */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#0E9F8E]">
          <div className="text-[12px] text-[#8A94A6]">p99 latency</div>
          <div className="text-[24px] font-semibold text-[#1B2433] font-mono tabular-nums leading-tight my-1">
            {metrics.p99_latency_ms.toFixed(1)} <span className="text-[14px] font-normal text-[#8A94A6]">ms</span>
          </div>
          <div className="text-[11px] text-[#8A94A6]">limit 100 ms</div>
        </div>

        {/* 4. Throughput (txn/s) */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#1F4FD8]">
          <div className="text-[12px] text-[#8A94A6]">Throughput</div>
          <div className="text-[24px] font-semibold text-[#1B2433] font-mono tabular-nums leading-tight my-1">
            {metrics.tps === 0 ? '0' : metrics.tps.toFixed(1)} <span className="text-[14px] font-normal text-[#8A94A6]">txn/s</span>
          </div>
          <div className="text-[11px] text-[#8A94A6]">last 10 s</div>
        </div>

        {/* 5. Allowed */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#13805B]">
          <div className="text-[12px] text-[#8A94A6]">Allowed</div>
          <div className="text-[24px] font-semibold text-[#13805B] font-mono tabular-nums leading-tight my-1">
            {metrics.allowed.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 6. Review */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#B7791F]">
          <div className="text-[12px] text-[#8A94A6]">Review</div>
          <div className="text-[24px] font-semibold text-[#B7791F] font-mono tabular-nums leading-tight my-1">
            {metrics.review.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 7. Blocked */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#C53030]">
          <div className="text-[12px] text-[#8A94A6]">Blocked</div>
          <div className="text-[24px] font-semibold text-[#C53030] font-mono tabular-nums leading-tight my-1">
            {metrics.blocked.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>

        {/* 8. Rings detected */}
        <div className="p-4 flex flex-col justify-between border-t-2 border-t-[#6D5BD0]">
          <div className="text-[12px] text-[#8A94A6]">Rings detected</div>
          <div className="text-[24px] font-semibold text-[#6D5BD0] font-mono tabular-nums leading-tight my-1">
            {metrics.rings_detected.toLocaleString()}
          </div>
          <div className="text-[11px] h-[16px]" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
};
