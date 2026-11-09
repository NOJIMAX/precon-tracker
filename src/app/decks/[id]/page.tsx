import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { clearDeckDiffAction, deleteDeckAction, recheckDeckAction } from "@/app/actions";
import { Flash } from "@/components/flash";
import { Submit } from "@/components/submit";
import { Badge, btn, Card, ChangeCell, Delta, Empty, input, Notice, Stat, Td, Th, yen } from "@/components/ui";
import { sql } from "@/lib/db";
import { FINISH_LABEL, SECTION_LABEL } from "@/lib/labels";
import { hareruyaSearchUrl } from "@/lib/prices/hareruya";
import { deckCardPrices, deckSummaries, summarize } from "@/lib/prices/totals";
import { STATUS_LABEL, type PriceStatus } from "@/lib/prices/types";
import { formatJst, jstDate } from "@/lib/time";
import type { DeckDiff } from "@/lib/decks/validate";

export const dynamic = "force-dynamic";

type SP = { sort?: string; dir?: string; q?: string; missing?: string; all?: string; msg?: string; err?: string };

export default async function DeckPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [deck] = await sql()<{
    id: string; name: string; language: string; set_code: string | null; release_date: string | null; image_url: string | null; status: string;
    source: string; official_url: string | null; mtgjson_file: string | null; commander_names: string[]; validation: { warnings?: string[]; countedTotal?: number; expected?: number };
    diff_detected_at: Date | null; last_checked_at: Date | null; product_name: string | null; expected_card_count: number;
  }[]>`
    select d.*, d.release_date::text, p.name as product_name from decks d left join products p on p.id = d.product_id where d.id = ${id}`;
  if (!deck) notFound();

  const today = jstDate();
  const [rows, sums, [rev]] = await Promise.all([
    deckCardPrices(id, today),
    deckSummaries([id]),
    sql()<{ diff: DeckDiff; checked_at: Date }[]>`select diff, checked_at from deck_revisions where deck_id = ${id} and changed order by checked_at desc limit 1`,
  ]);
  const live = summarize(rows);
  const s = sums.get(id);

  // 絞り込み・並べ替え（表示のみ。合計は全カードで計算）
  let view = rows.filter((r) => sp.all === "1" || r.section === "commander" || r.section === "main");
  if (sp.q) {
    const q = sp.q.toLowerCase();
    view = view.filter((r) => r.card_name.toLowerCase().includes(q) || (r.name_ja ?? "").includes(sp.q!));
  }
  if (sp.missing === "1") view = view.filter((r) => r.included && r.unit_price == null);
  const dir = sp.dir === "asc" ? 1 : -1;
  const change = (r: (typeof rows)[number]) => (r.unit_price != null && r.prev_unit_price != null ? (r.unit_price - r.prev_unit_price) * r.quantity : null);
  const key: Record<string, (r: (typeof rows)[number]) => number | string | null> = {
    price: (r) => r.unit_price,
    subtotal: (r) => (r.unit_price == null ? null : r.unit_price * r.quantity),
    change: (r) => change(r),
    name: (r) => r.card_name,
  };
  const sortKey = sp.sort && key[sp.sort] ? sp.sort : "price";
  view.sort((a, b) => {
    const x = key[sortKey](a), y = key[sortKey](b);
    if (x == null && y == null) return a.line_no - b.line_no;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) * dir;
  });
  const qs = (o: Partial<SP>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ sort: sortKey, dir: sp.dir, q: sp.q, missing: sp.missing, all: sp.all, ...o })) if (v) p.set(k, v);
    return `/decks/${id}?${p.toString()}`;
  };
  const sortHref = (k: string) => qs({ sort: k, dir: sortKey === k && sp.dir !== "asc" ? "asc" : undefined });

  return (
    <div className="space-y-5">
      <Flash msg={sp.msg} err={sp.err} />
      <div className="flex flex-col gap-4 md:flex-row">
        {deck.image_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={deck.image_url} alt="" title={deck.commander_names.join(" / ")} className="w-40 shrink-0 self-start rounded-lg" />
        )}
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <div className="text-xs text-gray-500">
              {deck.product_name ?? "—"} ・ {deck.set_code ?? "—"} ・ {deck.release_date ?? "発売日不明"} ・ {deck.language === "ja" ? "日本語版" : "英語版"}
            </div>
            <h1 className="text-xl font-semibold">{deck.name}</h1>
            <div className="text-sm text-gray-600">統率者: {deck.commander_names.join(" / ") || "未確定"}</div>
          </div>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Stat
              label={live.isComplete ? "合計買取価格（最新）" : "取得済みカードの小計"}
              value={yen(live.total)}
              tone={live.isComplete ? undefined : "warn"}
              sub={live.isComplete ? `全${live.targetCount}種類の価格あり` : `未取得 ${live.missingCount} / ${live.targetCount}種類（完全な合計ではありません）`}
            />
            <Stat label="前日比" value={<ChangeCell c={s?.d1 ?? null} />} sub={<>7日前比 <ChangeCell c={s?.d7 ?? null} /></>} />
            <Stat label="30日前比" value={<ChangeCell c={s?.d30 ?? null} />} sub={`取得成功率 ${live.targetCount ? Math.round((live.pricedCount / live.targetCount) * 100) : 0}%`} />
            <Stat
              label="最高 / 最低記録"
              value={<span className="text-base">{s?.maxTotal ? yen(s.maxTotal.value) : "—"} / {s?.minTotal ? yen(s.minTotal.value) : "—"}</span>}
              sub={`全カード揃った日のみ ・ 集計 ${formatJst(s?.computedAt)}`}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/decks/${id}/history`} className={btn}>価格推移</Link>
            <a href={`/api/decks/${id}/csv`} className={btn}>CSVエクスポート</a>
            {(deck.official_url || deck.mtgjson_file) && (
              <form action={recheckDeckAction}><input type="hidden" name="deck_id" value={id} /><Submit pendingText="確認中…">公式リストと照合</Submit></form>
            )}
            {deck.official_url && <a href={deck.official_url} target="_blank" rel="noreferrer" className={btn}>公式ページ ↗</a>}
          </div>
        </div>
      </div>

      {deck.diff_detected_at && (
        <Notice tone="red">
          <div className="font-medium">公式デッキリストの変更を検知しました（{formatJst(deck.diff_detected_at)}）</div>
          {rev && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {rev.diff.added.map((a, i) => <li key={`a${i}`}>追加: {a.quantity} {a.name}</li>)}
              {rev.diff.removed.map((a, i) => <li key={`r${i}`}>削除: {a.quantity} {a.name}</li>)}
              {rev.diff.changed.map((a, i) => <li key={`c${i}`}>枚数変更: {a.name} {a.from} → {a.to}</li>)}
            </ul>
          )}
          <p className="mt-1 text-xs">保存済みのリストは自動では書き換えていません。内容を確認のうえ、必要ならデッキを削除して登録し直してください。</p>
          <form action={clearDeckDiffAction} className="mt-2"><input type="hidden" name="deck_id" value={id} /><Submit>確認済みにする</Submit></form>
        </Notice>
      )}
      {deck.status === "needs_review" && (deck.validation.warnings?.length ?? 0) > 0 && (
        <Notice>
          <div className="font-medium">確認待ちの項目があります</div>
          <ul className="mt-1 list-disc pl-5 text-xs">{deck.validation.warnings!.slice(0, 10).map((w, i) => <li key={i}>{w}</li>)}</ul>
          <Link href="/admin#review" className="text-xs underline">管理画面で印刷仕様を確定する</Link>
        </Notice>
      )}

      <Card
        title={`収録カード（${view.length}行）`}
        actions={
          <form className="flex flex-wrap items-center gap-2 text-xs" action={`/decks/${id}`}>
            <input type="hidden" name="sort" value={sortKey} />
            <input name="q" defaultValue={sp.q} placeholder="カード名で検索" className={`${input} w-40 py-1 text-xs`} />
            <label className="flex items-center gap-1"><input type="checkbox" name="missing" value="1" defaultChecked={sp.missing === "1"} />未取得のみ</label>
            <label className="flex items-center gap-1"><input type="checkbox" name="all" value="1" defaultChecked={sp.all === "1"} />トークン等も表示</label>
            <button className="rounded border border-gray-300 px-2 py-1">表示</button>
          </form>
        }
      >
        {view.length === 0 ? (
          <Empty>該当するカードがありません</Empty>
        ) : (
          <div className="-mx-4 -my-4 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <Th href={sortHref("name")} active={sortKey === "name"}>カード名</Th>
                  <Th>版</Th>
                  <Th className="text-right">枚数</Th>
                  <Th className="text-right" href={sortHref("price")} active={sortKey === "price"}>単価</Th>
                  <Th className="text-right" href={sortHref("subtotal")} active={sortKey === "subtotal"}>小計</Th>
                  <Th className="text-right" href={sortHref("change")} active={sortKey === "change"}>前日比</Th>
                  <Th>取得状況</Th>
                  <Th>晴れる屋</Th>
                </tr>
              </thead>
              <tbody>
                {view.map((r) => {
                  const ch = change(r);
                  const stale = r.unit_price == null && r.last_ok_price != null;
                  return (
                    <tr key={r.deck_card_id} className={clsx("hover:bg-gray-50", !r.included && "text-gray-400")}>
                      <Td>
                        <div className="font-medium">{r.card_name}</div>
                        <div className="text-xs text-gray-500">
                          {r.name_ja}
                          {r.section !== "main" && <span className="ml-1"><Badge>{SECTION_LABEL[r.section]}</Badge></span>}
                          {r.is_basic_land && <span className="ml-1"><Badge>基本土地</Badge></span>}
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-gray-600">
                        {r.printing_id ? (
                          <>
                            {r.set_code} #{r.collector_number} {r.finish !== "nonfoil" && <Badge tone="blue">{FINISH_LABEL[r.finish!]}</Badge>}
                            {r.variant && <span className="ml-1 text-gray-400">{r.variant}</span>}
                          </>
                        ) : (
                          <Badge tone="amber">版未確定</Badge>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{r.quantity}</Td>
                      <Td className="text-right tabular-nums">
                        {r.unit_price != null ? yen(r.unit_price) : <span className="text-gray-400">—</span>}
                        {r.is_anomaly && <span title="前回から大きく変動" className="ml-1 text-amber-600">⚠</span>}
                      </Td>
                      <Td className="text-right tabular-nums">{r.unit_price != null ? yen(r.unit_price * r.quantity) : "—"}</Td>
                      <Td className="text-right" >
                        <span title={r.prev_unit_price != null ? `前日単価 ${yen(r.prev_unit_price)}` : undefined}><Delta yen={ch} /></span>
                      </Td>
                      <Td className="whitespace-nowrap text-xs">
                        {!r.included ? (
                          <span>集計対象外</span>
                        ) : r.unit_price != null ? (
                          <span className="text-gray-600">
                            {r.price_date}
                            {r.last_status && r.last_status !== "ok" && r.price_date !== today && (
                              <div title={r.last_detail ?? undefined}><Badge tone="amber">最新: {STATUS_LABEL[r.last_status as PriceStatus]}</Badge></div>
                            )}
                          </span>
                        ) : (
                          <span title={r.last_detail ?? undefined}>
                            <Badge tone="red">{r.last_status ? STATUS_LABEL[r.last_status as PriceStatus] : r.printing_id ? "未取得" : "版未確定"}</Badge>
                            {stale && <div className="text-gray-500">最終成功 {yen(r.last_ok_price)}（{r.last_ok_date}）</div>}
                          </span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs">
                        {r.product_url ? (
                          <a href={r.product_url} target="_blank" rel="noreferrer" className="underline">商品 ↗</a>
                        ) : r.printing_id ? (
                          <a href={hareruyaSearchUrl(r.card_name, deck.language as "ja" | "en")} target="_blank" rel="noreferrer" className="text-gray-500 underline">検索 ↗</a>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <details className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer text-gray-600">デッキの削除</summary>
        <form action={deleteDeckAction} className="mt-3 flex flex-wrap items-center gap-2">
          <input type="hidden" name="deck_id" value={id} />
          <input name="confirm" placeholder="「削除」と入力" className={input} />
          <Submit>このデッキを削除</Submit>
          <span className="text-xs text-gray-500">価格履歴（カード単位）は残ります。デッキの合計推移は削除されます。</span>
        </form>
      </details>
    </div>
  );
}
