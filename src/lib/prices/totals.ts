import { getSetting, sql } from "../db";
import { addDays, jstDate } from "../time";

export const DEFAULT_SOURCE = "hareruya_buyback";

export interface DeckCardPriceRow {
  deck_card_id: string;
  line_no: number;
  card_name: string;
  name_ja: string | null;
  quantity: number;
  section: string;
  is_basic_land: boolean;
  resolution_status: string;
  note: string | null;
  printing_id: string | null;
  set_code: string | null;
  collector_number: string | null;
  language: string | null;
  finish: string | null;
  variant: string | null;
  image_url: string | null;
  unit_price: number | null;        // 合計に使う単価（期限内の最終成功価格）
  price_date: string | null;
  price_observed_at: Date | null;
  is_anomaly: boolean | null;
  prev_unit_price: number | null;   // 前日時点の単価
  last_status: string | null;       // 最新の取得結果
  last_attempt_at: Date | null;
  last_detail: string | null;
  last_ok_price: number | null;     // 期限に関係なく最後に成功した価格
  last_ok_date: string | null;
  product_url: string | null;
  match_status: string | null;
  included: boolean;                // 合計の対象か
}

/** デッキの各カードの単価（asOf 日時点）と前日の単価 */
export async function deckCardPrices(deckId: string, asOf = jstDate(), sourceId = DEFAULT_SOURCE): Promise<DeckCardPriceRow[]> {
  const maxAge = Number(await getSetting("price_max_age_days", 7));
  const basicPolicy = await getSetting<string>("basic_land_policy", "exclude");
  const prevDay = addDays(asOf, -1);
  const rows = await sql()<Omit<DeckCardPriceRow, "included">[]>`
    select dc.id as deck_card_id, dc.line_no, dc.card_name, c.name_ja, dc.quantity, dc.section, dc.is_basic_land,
           dc.resolution_status, dc.note, dc.printing_id, p.set_code, p.collector_number, p.language, p.finish, p.variant, p.image_url,
           cur.price_jpy as unit_price, cur.observed_date::text as price_date, cur.observed_at as price_observed_at, cur.is_anomaly,
           prv.price_jpy as prev_unit_price,
           pl.last_status, pl.last_attempt_at, pl.last_detail, pl.last_ok_price_jpy as last_ok_price, pl.last_ok_date::text as last_ok_date,
           sp.url as product_url, sp.match_status
      from deck_cards dc
      left join card_printings p on p.id = dc.printing_id
      left join cards c on c.id = p.card_id
      left join lateral (
        select price_jpy, observed_date, observed_at, is_anomaly from price_history
         where printing_id = dc.printing_id and source_id = ${sourceId} and status = 'ok'
           and observed_date <= ${asOf}::date and observed_date > ${asOf}::date - ${maxAge}::int
         order by observed_date desc limit 1) cur on true
      left join lateral (
        select price_jpy from price_history
         where printing_id = dc.printing_id and source_id = ${sourceId} and status = 'ok'
           and observed_date <= ${prevDay}::date and observed_date > ${prevDay}::date - ${maxAge}::int
         order by observed_date desc limit 1) prv on true
      left join price_latest pl on pl.printing_id = dc.printing_id and pl.source_id = ${sourceId}
      left join source_products sp on sp.printing_id = dc.printing_id and sp.source_id = ${sourceId} and sp.match_status <> 'rejected'
     where dc.deck_id = ${deckId}
     order by dc.line_no`;
  return rows.map((r) => ({
    ...r,
    included:
      (r.section === "commander" || r.section === "main") &&
      (!r.is_basic_land || (basicPolicy === "include_if_priced" && r.unit_price != null)),
  }));
}

export interface DeckTotal {
  total: number;
  pricedCount: number;
  missingCount: number;
  targetCount: number;
  isComplete: boolean;
}

export function summarize(rows: DeckCardPriceRow[]): DeckTotal {
  const target = rows.filter((r) => r.included);
  const priced = target.filter((r) => r.unit_price != null);
  return {
    total: priced.reduce((s, r) => s + r.unit_price! * r.quantity, 0),
    pricedCount: priced.length,
    missingCount: target.length - priced.length,
    targetCount: target.length,
    isComplete: target.length > 0 && priced.length === target.length,
  };
}

/** 全デッキの日次スナップショットを作る（同じ日の再計算は上書き） */
export async function snapshotAllDecks(date = jstDate(), sourceId = DEFAULT_SOURCE) {
  const decks = await sql()<{ id: string }[]>`select id from decks`;
  for (const d of decks) {
    const t = summarize(await deckCardPrices(d.id, date, sourceId));
    await sql()`
      insert into deck_daily_totals (deck_id, source_id, snapshot_date, total_jpy, priced_count, missing_count, target_count, is_complete)
      values (${d.id}, ${sourceId}, ${date}, ${t.total}, ${t.pricedCount}, ${t.missingCount}, ${t.targetCount}, ${t.isComplete})
      on conflict (deck_id, source_id, snapshot_date) do update set total_jpy = excluded.total_jpy, priced_count = excluded.priced_count,
        missing_count = excluded.missing_count, target_count = excluded.target_count, is_complete = excluded.is_complete, computed_at = now()`;
  }
  return decks.length;
}

export interface Change {
  yen: number;
  pct: number | null;
  /** 比較した両日とも全カードの価格が揃っているか */
  comparable: boolean;
  baseDate: string;
}

function change(cur: { total_jpy: number; is_complete: boolean }, base?: { total_jpy: number; is_complete: boolean; snapshot_date: string }): Change | null {
  if (!base) return null;
  return {
    yen: cur.total_jpy - base.total_jpy,
    pct: base.total_jpy ? ((cur.total_jpy - base.total_jpy) / base.total_jpy) * 100 : null,
    comparable: cur.is_complete && base.is_complete,
    baseDate: base.snapshot_date,
  };
}

export interface DeckSummary {
  deckId: string;
  latestDate: string | null;
  total: number | null;
  pricedCount: number;
  missingCount: number;
  targetCount: number;
  isComplete: boolean;
  successRate: number | null;
  d1: Change | null;
  d7: Change | null;
  d30: Change | null;
  maxTotal: { value: number; date: string } | null;
  minTotal: { value: number; date: string } | null;
  computedAt: Date | null;
}

type SnapRow = { deck_id: string; snapshot_date: string; total_jpy: number; priced_count: number; missing_count: number; target_count: number; is_complete: boolean; computed_at: Date };

/**
 * 全デッキ（または指定デッキ）の最新スナップショットと比較値。
 * 前日比などは、比較元の日のスナップショットがある場合だけ出します。
 * 最高・最低記録は「全カードの価格が揃っていた日」だけを対象にします。
 */
export async function deckSummaries(deckIds?: string[], sourceId = DEFAULT_SOURCE): Promise<Map<string, DeckSummary>> {
  const db = sql();
  const snaps = await db<SnapRow[]>`
    select deck_id, snapshot_date::text, total_jpy, priced_count, missing_count, target_count, is_complete, computed_at
      from deck_daily_totals
     where source_id = ${sourceId} ${deckIds ? db`and deck_id in ${db(deckIds)}` : db``}
     order by deck_id, snapshot_date`;
  const byDeck = new Map<string, SnapRow[]>();
  for (const s of snaps) byDeck.set(s.deck_id, [...(byDeck.get(s.deck_id) ?? []), s]);
  const out = new Map<string, DeckSummary>();
  for (const [deckId, list] of byDeck) {
    const cur = list[list.length - 1];
    const at = (days: number) => {
      const target = addDays(cur.snapshot_date, -days);
      // 指定日、無ければそれ以前で最も近い日（3日以内）
      const cands = list.filter((s) => s.snapshot_date <= target && s.snapshot_date >= addDays(target, -3));
      return cands[cands.length - 1];
    };
    const complete = list.filter((s) => s.is_complete);
    const max = complete.reduce<SnapRow | undefined>((a, s) => (!a || s.total_jpy > a.total_jpy ? s : a), undefined);
    const min = complete.reduce<SnapRow | undefined>((a, s) => (!a || s.total_jpy < a.total_jpy ? s : a), undefined);
    out.set(deckId, {
      deckId,
      latestDate: cur.snapshot_date,
      total: cur.total_jpy,
      pricedCount: cur.priced_count,
      missingCount: cur.missing_count,
      targetCount: cur.target_count,
      isComplete: cur.is_complete,
      successRate: cur.target_count ? cur.priced_count / cur.target_count : null,
      d1: change(cur, at(1)),
      d7: change(cur, at(7)),
      d30: change(cur, at(30)),
      maxTotal: max ? { value: max.total_jpy, date: max.snapshot_date } : null,
      minTotal: min ? { value: min.total_jpy, date: min.snapshot_date } : null,
      computedAt: cur.computed_at,
    });
  }
  return out;
}
