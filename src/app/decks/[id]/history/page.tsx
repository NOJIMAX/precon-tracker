import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { PriceChart } from "@/components/price-chart";
import { Card, Delta, Empty, pct, Td, Th, yen } from "@/components/ui";
import { sql } from "@/lib/db";
import { DEFAULT_SOURCE } from "@/lib/prices/totals";
import { addDays, jstDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const RANGES: Record<string, { label: string; days: number | null }> = {
  "7": { label: "7日", days: 7 },
  "30": { label: "30日", days: 30 },
  "90": { label: "90日", days: 90 },
  all: { label: "全期間", days: null },
};

export default async function HistoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string; card?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [deck] = await sql()<{ name: string; language: string }[]>`select name, language from decks where id = ${id}`;
  if (!deck) notFound();
  const range = RANGES[sp.range ?? "30"] ? (sp.range ?? "30") : "30";
  const days = RANGES[range].days;
  const from = days ? addDays(jstDate(), -days) : "1900-01-01";
  const db = sql();

  const totals = await db<{ snapshot_date: string; total_jpy: number; is_complete: boolean; missing_count: number }[]>`
    select snapshot_date::text, total_jpy, is_complete, missing_count from deck_daily_totals
     where deck_id = ${id} and source_id = ${DEFAULT_SOURCE} and snapshot_date >= ${from} order by snapshot_date`;

  // 期間内のカード別の値動き（期間内の最初と最後の成功価格を比較）
  const movers = await db<{ printing_id: string; card_name: string; name_ja: string | null; set_code: string; collector_number: string; finish: string; quantity: number; first_price: number; last_price: number; first_date: string; last_date: string; n: number }[]>`
    with dc as (
      select printing_id, min(card_name) as card_name, sum(quantity)::int as quantity from deck_cards
       where deck_id = ${id} and printing_id is not null and section in ('commander','main') group by printing_id),
    ph as (
      select ph.printing_id, ph.price_jpy, ph.observed_date,
             row_number() over (partition by ph.printing_id order by ph.observed_date) as rn_first,
             row_number() over (partition by ph.printing_id order by ph.observed_date desc) as rn_last,
             count(*) over (partition by ph.printing_id) as n
        from price_history ph join dc using (printing_id)
       where ph.source_id = ${DEFAULT_SOURCE} and ph.status = 'ok' and ph.observed_date >= ${from})
    select dc.printing_id, dc.card_name, c.name_ja, p.set_code, p.collector_number, p.finish, dc.quantity,
           f.price_jpy as first_price, l.price_jpy as last_price, f.observed_date::text as first_date, l.observed_date::text as last_date, f.n::int as n
      from dc
      join ph f on f.printing_id = dc.printing_id and f.rn_first = 1
      join ph l on l.printing_id = dc.printing_id and l.rn_last = 1
      join card_printings p on p.id = dc.printing_id join cards c on c.id = p.card_id
     where f.n > 1`;
  movers.sort((a, b) => Math.abs((b.last_price - b.first_price) * b.quantity) - Math.abs((a.last_price - a.first_price) * a.quantity));

  const selected = sp.card && movers.find((m) => m.printing_id === sp.card) ? sp.card : movers[0]?.printing_id;
  const cardSeries = selected
    ? await db<{ observed_date: string; price_jpy: number; is_anomaly: boolean; method: string }[]>`
        select observed_date::text, price_jpy, is_anomaly, method from price_history
         where printing_id = ${selected} and source_id = ${DEFAULT_SOURCE} and status = 'ok' and observed_date >= ${from} order by observed_date`
    : [];
  const sel = movers.find((m) => m.printing_id === selected);
  const link = (o: { range?: string; card?: string }) => {
    const p = new URLSearchParams({ range: o.range ?? range, ...(o.card ?? selected ? { card: (o.card ?? selected)! } : {}) });
    return `/decks/${id}/history?${p}`;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link href={`/decks/${id}`} className="text-xs text-gray-500 hover:underline">← {deck.name}</Link>
          <h1 className="text-xl font-semibold">価格推移</h1>
        </div>
        <div className="flex gap-1 text-sm">
          {Object.entries(RANGES).map(([k, v]) => (
            <Link key={k} href={link({ range: k })} className={clsx("rounded px-3 py-1", range === k ? "bg-gray-900 text-white" : "bg-white ring-1 ring-gray-200")}>{v.label}</Link>
          ))}
        </div>
      </div>

      <Card title="デッキ合計買取価格">
        <PriceChart data={totals.map((t) => ({ date: t.snapshot_date, value: t.total_jpy, incomplete: !t.is_complete, note: t.is_complete ? undefined : `未取得 ${t.missing_count}` }))} />
        <p className="mt-2 text-xs text-gray-500">白抜きの点は未取得カードを含む日（取得済みカードの小計）です。</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card title="値動きの大きいカード" className="lg:col-span-3">
          {movers.length === 0 ? (
            <Empty>期間内に2回以上価格が記録されたカードがありません</Empty>
          ) : (
            <div className="-mx-4 -my-4 max-h-[460px] overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0">
                  <tr><Th>カード名</Th><Th className="text-right">期間初め</Th><Th className="text-right">最新</Th><Th className="text-right">変動（小計）</Th><Th className="text-right">変動率</Th></tr>
                </thead>
                <tbody>
                  {movers.slice(0, 50).map((m) => (
                    <tr key={m.printing_id} className={clsx("hover:bg-gray-50", m.printing_id === selected && "bg-gray-50")}>
                      <Td>
                        <Link href={link({ card: m.printing_id })} className="font-medium hover:underline">{m.card_name}</Link>
                        <div className="text-xs text-gray-500">{m.set_code} #{m.collector_number}{m.finish !== "nonfoil" ? ` ${m.finish}` : ""}{m.quantity > 1 ? ` ×${m.quantity}` : ""}</div>
                      </Td>
                      <Td className="text-right tabular-nums">{yen(m.first_price)}<div className="text-xs text-gray-400">{m.first_date}</div></Td>
                      <Td className="text-right tabular-nums">{yen(m.last_price)}<div className="text-xs text-gray-400">{m.last_date}</div></Td>
                      <Td className="text-right"><Delta yen={(m.last_price - m.first_price) * m.quantity} /></Td>
                      <Td className="text-right tabular-nums">{m.first_price ? pct(((m.last_price - m.first_price) / m.first_price) * 100) : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={sel ? `${sel.card_name} の単価` : "カード単体の推移"} className="lg:col-span-2">
          <PriceChart height={240} data={cardSeries.map((c) => ({ date: c.observed_date, value: c.price_jpy, note: `${c.method === "auto" ? "自動" : c.method === "csv" ? "CSV" : "手入力"}${c.is_anomaly ? " ⚠大きな変動" : ""}` }))} />
          <p className="mt-2 text-xs text-gray-500">左の一覧のカード名を選ぶと切り替わります。</p>
        </Card>
      </div>
    </div>
  );
}
