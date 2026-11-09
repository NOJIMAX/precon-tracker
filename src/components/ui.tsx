import Link from "next/link";
import clsx from "clsx";
import type { ReactNode } from "react";
import type { Change } from "@/lib/prices/totals";

export const yen = (n: number | null | undefined) => (n == null ? "—" : `¥${Math.round(n).toLocaleString("ja-JP")}`);
export const signedYen = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}¥${Math.abs(Math.round(n)).toLocaleString("ja-JP")}`;
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(1)}%`);

export function Delta({ yen: v, pct: p, muted }: { yen: number | null | undefined; pct?: number | null; muted?: boolean }) {
  if (v == null) return <span className="text-gray-400">—</span>;
  return (
    <span className={clsx("tabular-nums", muted ? "text-gray-500" : v > 0 ? "text-green-700" : v < 0 ? "text-red-700" : "text-gray-600")}>
      {signedYen(v)}
      {p !== undefined && <span className="ml-1 text-xs">({pct(p)})</span>}
    </span>
  );
}

/** デッキ合計の比較。比較した日のどちらかで価格が揃っていない場合は注記する */
export function ChangeCell({ c }: { c: Change | null }) {
  if (!c) return <span className="text-gray-400">—</span>;
  return (
    <span title={`${c.baseDate} との比較${c.comparable ? "" : "（未取得カードを含むため参考値）"}`}>
      <Delta yen={c.yen} pct={c.pct} muted={!c.comparable} />
      {!c.comparable && <span className="ml-0.5 text-[10px] text-amber-600">参考</span>}
    </span>
  );
}

export function Card({ title, children, className, actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={clsx("rounded-lg border border-gray-200 bg-white", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-gray-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "bad" }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={clsx("mt-1 text-xl font-semibold tabular-nums", tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-gray-900")}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "green" | "red" | "amber" | "blue" }) {
  const tones = {
    gray: "bg-gray-100 text-gray-700",
    green: "bg-green-50 text-green-800 ring-green-200",
    red: "bg-red-50 text-red-800 ring-red-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    blue: "bg-blue-50 text-blue-800 ring-blue-200",
  };
  return <span className={clsx("inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-xs ring-1 ring-inset ring-transparent", tones[tone])}>{children}</span>;
}

export const btn =
  "inline-flex items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-50";
export const btnPrimary =
  "inline-flex items-center justify-center gap-1 rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50";
export const input = "rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:border-gray-500 focus:outline-none";

export function Th({ children, className, href, active }: { children: ReactNode; className?: string; href?: string; active?: boolean }) {
  return (
    <th className={clsx("whitespace-nowrap border-b border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium text-gray-600", className)}>
      {href ? (
        <Link href={href} className={clsx("hover:text-gray-900", active && "text-gray-900 underline")}>
          {children}
        </Link>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={clsx("border-b border-gray-100 px-3 py-2 text-sm", className)}>{children}</td>;
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "red" | "blue" | "green"; children: ReactNode }) {
  const tones = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    green: "border-green-200 bg-green-50 text-green-900",
  };
  return <div className={clsx("rounded-md border px-3 py-2 text-sm", tones[tone])}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-gray-500">{children}</p>;
}
