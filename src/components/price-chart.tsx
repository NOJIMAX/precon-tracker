"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface Point {
  date: string;
  value: number | null;
  /** その日の合計に未取得カードが含まれるか */
  incomplete?: boolean;
  note?: string;
}

const fmt = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

export function PriceChart({ data, height = 280 }: { data: Point[]; height?: number }) {
  if (!data.length) return <p className="py-10 text-center text-sm text-gray-500">記録がありません</p>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="#eef0f2" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
          <YAxis tick={{ fontSize: 11, fill: "#6b7280" }} tickFormatter={(v: number) => fmt(v)} width={80} domain={["auto", "auto"]} />
          <Tooltip
            formatter={(v) => [fmt(Number(v)), "買取価格"]}
            labelFormatter={(label, payload) => {
              const p = payload?.[0]?.payload as Point | undefined;
              return `${label}${p?.incomplete ? "（未取得カードあり・小計）" : ""}${p?.note ? ` ${p.note}` : ""}`;
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#111827"
            strokeWidth={2}
            connectNulls
            isAnimationActive={false}
            dot={(props) => {
              const p = props.payload as Point;
              return <circle key={props.key} cx={props.cx} cy={props.cy} r={3} fill={p.incomplete ? "#fff" : "#111827"} stroke={p.incomplete ? "#d97706" : "#111827"} strokeWidth={1.5} />;
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
