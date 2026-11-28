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
    <div className="w-full bg-[#FFFFFF] border border-[#E3E7EE] rounded-[6px] p-4 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between pb-3 border-b border-[#E3E7EE] mb-2">
        <div className="border-l-[3px] border-l-[#1F4FD8] pl-2.5 py-0.5">
          <h2 className="text-[15px] font-semibold text-[#1B2433]">Scoring latency</h2>
        </div>
        <div className="text-[12px] text-[#8A94A6]">
          Average <span className="font-mono tabular-nums font-semibold text-[#1B2433]">{currentAvg.toFixed(1)} ms</span>
        </div>
      </div>

      <div className="w-full h-[180px]">
        {data.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-[13px] text-[#8A94A6]">
            No latency points recorded yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#E3E7EE" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 11, fill: '#8A94A6' }}
                tickLine={false}
                axisLine={{ stroke: '#E3E7EE' }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#8A94A6' }}
                tickLine={false}
                axisLine={{ stroke: '#E3E7EE' }}
                unit="ms"
                domain={[0, (dataMax: number) => Math.max(120, Math.ceil(dataMax * 1.2))]}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const point = payload[0].payload as LatencyHistoryPoint;
                    return (
                      <div className="bg-[#FFFFFF] border border-[#E3E7EE] rounded-[4px] p-2 text-[12px] shadow-sm">
                        <div className="text-[#8A94A6] font-mono text-[11px]">{point.time}</div>
                        <div className="font-semibold text-[#1B2433] font-mono tabular-nums mt-0.5">
                          {point.latency.toFixed(1)} ms
                        </div>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <ReferenceLine
                y={100}
                stroke="#B7791F"
                strokeDasharray="4 4"
              />
              <Line
                type="monotone"
                dataKey="latency"
                stroke="#1F4FD8"
                strokeWidth={1.75}
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
