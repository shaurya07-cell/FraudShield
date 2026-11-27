import React from 'react';
import type { DetectedRing } from '../types/fraud';

interface DetectedRingsTableProps {
  rings: DetectedRing[];
}

export const DetectedRingsTable: React.FC<DetectedRingsTableProps> = ({ rings }) => {
  return (
    <div className="w-full bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-4 flex flex-col">
      <div className="flex items-center justify-between pb-3 border-b border-[#DCE0E7] mb-2">
        <h2 className="text-[16px] font-medium text-[#1B2433]">Detected rings</h2>
        <span className="text-[12px] text-[#5B6575] tabular-nums">
          {rings.length} {rings.length === 1 ? 'ring' : 'rings'} active
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-[#DCE0E7] text-[#5B6575] text-[12px]">
              <th className="py-2 pr-4 font-normal">Ring</th>
              <th className="py-2 px-4 font-normal">Members</th>
              <th className="py-2 pl-4 font-normal text-right">Score</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#DCE0E7]">
            {rings.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-6 text-center text-[#5B6575] text-[13px]">
                  No rings detected yet. Run a ring attack scenario to simulate circular layering.
                </td>
              </tr>
            ) : (
              rings.map((ring) => (
                <tr key={ring.ring_id} className="hover:bg-[#F4F5F7] transition-colors">
                  <td className="py-2.5 pr-4 font-mono text-[#C0362C] font-medium">
                    {ring.ring_id}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[#5B6575]">
                    <div className="flex flex-wrap gap-1 max-w-[320px]">
                      {ring.members.map((m) => (
                        <span key={m} className="bg-[#F4F5F7] border border-[#DCE0E7] px-1.5 py-0.5 rounded-[4px] text-[11px] text-[#1B2433]">
                          {m}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2.5 pl-4 font-semibold text-right tabular-nums text-[#C0362C]">
                    {ring.score}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
