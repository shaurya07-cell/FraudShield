import React from 'react';
import type { DetectedRing } from '../types/fraud';

interface DetectedRingsTableProps {
  rings: DetectedRing[];
}

export const DetectedRingsTable: React.FC<DetectedRingsTableProps> = ({ rings }) => {
  return (
    <div className="w-full bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] p-4 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between pb-3 border-b border-[#E3E7EE] mb-2">
        <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5">
          <h2 className="text-[15px] font-semibold text-[#1B2433]">Detected rings</h2>
        </div>
        <span className="text-[12px] text-[#8A94A6] font-mono tabular-nums">
          {rings.length} {rings.length === 1 ? 'ring' : 'rings'} active
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px] border-collapse">
          <thead className="bg-[#F4F5F7] border-b border-[#E3E7EE]">
            <tr className="text-[#8A94A6] text-[11px] font-medium">
              <th className="py-2.5 px-3">Ring</th>
              <th className="py-2.5 px-3">Members</th>
              <th className="py-2.5 px-3 text-right">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#E3E7EE]">
            {rings.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-6 text-center text-[#8A94A6] text-[13px]">
                  No rings detected yet. Run a ring attack scenario to simulate circular layering.
                </td>
              </tr>
            ) : (
              rings.map((ring, idx) => {
                const zebraBg = idx % 2 === 1 ? 'bg-[#F4F5F7]/30' : 'bg-[#FFFFFF]';
                return (
                  <tr key={ring.ring_id} className={`${zebraBg} hover:bg-[#EEF3FD]/60 transition-colors`}>
                    <td className="py-2.5 px-3 font-mono text-[#6D5BD0] font-medium">
                      {ring.ring_id}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#1B2433]">
                      <div className="flex flex-wrap gap-1 max-w-[320px]">
                        {ring.members.map((m) => (
                          <span key={m} className="bg-[#F4F5F7] border border-[#E3E7EE] px-1.5 py-0.5 rounded-[4px] text-[11px] text-[#1B2433]">
                            {m}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 font-semibold text-right font-mono tabular-nums text-[#C53030]">
                      {ring.score}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
