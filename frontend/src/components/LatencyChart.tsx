import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { LatencyHistoryPoint } from '../types/fraud';

interface LatencyChartProps {
  data: LatencyHistoryPoint[];
  currentAvg: number;
}

export const LatencyChart: React.FC<LatencyChartProps> = ({ data, currentAvg }) => {
  return (
    <div className="w-full bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-4 flex flex-col">
      <div className="flex items-center justify-between pb-3 border-b border-[#DCE0E7] mb-2">
        <h2 className="text-[16px] font-medium text-[#1B2433]">Scoring latency</h2>
        <div className="text-[12px] text-[#5B6575]">
          Average <span className="tabular-nums font-semibold text-[#1B2433]">{currentAvg.toFixed(1)} ms</span>
        </div>
      </div>

      <div className="w-full h-[180px]">
        {data.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-[13px] text-[#5B6575]">
            No latency points recorded yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#F0F2F5" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 11, fill: '#5B6575' }}
                tickLine={false}
                axisLine={{ stroke: '#DCE0E7' }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#5B6575' }}
                tickLine={false}
                axisLine={{ stroke: '#DCE0E7' }}
                unit="ms"
                domain={[0, (dataMax: number) => Math.max(120, Math.ceil(dataMax * 1.2))]}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const point = payload[0].payload as LatencyHistoryPoint;
                    return (
                      <div className="bg-[#FFFFFF] border border-[#DCE0E7] rounded-[4px] p-2 text-[12px] shadow-sm">
                        <div className="text-[#5B6575]">{point.time}</div>
                        <div className="font-semibold text-[#1B2433] tabular-nums mt-0.5">
                          {point.latency.toFixed(1)} ms
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              {/* Reference line at 100 ms SLA limit */}
              <ReferenceLine
                y={100}
                stroke="#C0362C"
                strokeDasharray="4 4"
                label={{
                  value: 'Limit 100 ms',
                  position: 'insideTopRight',
                  fill: '#C0362C',
                  fontSize: 10,
                }}
              />
              <Line
                type="monotone"
                dataKey="latency"
                stroke="#1F4FD8"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
