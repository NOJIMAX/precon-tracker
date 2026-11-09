import { sql } from "./db";
import { deckSummaries, DEFAULT_SOURCE, type DeckSummary } from "./prices/totals";

export interface DeckListItem {
  id: string;
  name: string;
  name_ja: string | null;
  language: "ja" | "en";
  set_code: string | null;
  release_date: string | null;
  image_url: string | null;
  status: "ok" | "needs_review";
  product_name: string | null;
  commander_names: string[];
  diff_detected_at: Date | null;
  summary: DeckSummary | null;
}

export async function listDecks(): Promise<DeckListItem[]> {
  const rows = await sql()<Omit<DeckListItem, "summary">[]>`
    select d.id, d.name, d.name_ja, d.language, d.set_code, d.release_date::text, d.image_url, d.status, d.commander_names,
           d.diff_detected_at, p.name as product_name
      from decks d left join products p on p.id = d.product_id
     order by d.release_date desc nulls last, d.name`;
  const sums = await deckSummaries();
  return rows.map((r) => ({ ...r, summary: sums.get(r.id) ?? null }));
}

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  trigger: string | null;
  started_at: Date;
  finished_at: Date | null;
  target_count: number;
  success_count: number;
  failure_count: number;
  retry_count: number;
  error: string | null;
  log: { at: string; level: string; message: string; error?: string }[];
}

export async function recentJobs(limit = 20) {
  return sql()<JobRow[]>`select * from update_jobs order by started_at desc limit ${limit}`;
}

export async function lastJob(kinds = ["daily", "manual"]) {
  const [last] = await sql()<JobRow[]>`select * from update_jobs where kind in ${sql()(kinds)} order by started_at desc limit 1`;
  const [ok] = await sql()<JobRow[]>`select * from update_jobs where kind in ${sql()(kinds)} and status in ('succeeded','partial') order by started_at desc limit 1`;
  return { last: last ?? null, lastSuccess: ok ?? null };
}

export interface FailedCard {
  printing_id: string;
  name_en: string;
  name_ja: string | null;
  set_code: string;
  collector_number: string;
  language: string;
  finish: string;
  last_status: string | null;
  last_attempt_at: Date | null;
  last_detail: string | null;
  last_ok_price: number | null;
  last_ok_date: string | null;
  candidates: unknown;
  deck_names: string[];
  product_url: string | null;
  match_status: string | null;
  source_product_id: string | null;
}

/**
 * 価格が取れていないカード版（集計対象のもの）。
 * 一度も記録が無いもの（未取得）と、最新の取得結果が失敗のものを含む。
 */
export async function failedCards(status?: string, sourceId = DEFAULT_SOURCE): Promise<FailedCard[]> {
  const db = sql();
  return db<FailedCard[]>`
    with targets as (
      select p.id as printing_id, array_agg(distinct d.name) as deck_names
        from deck_cards dc join card_printings p on p.id = dc.printing_id join decks d on d.id = dc.deck_id
       where dc.section in ('commander','main') and not dc.is_basic_land
       group by p.id)
    select t.printing_id, c.name_en, c.name_ja, p.set_code, p.collector_number, p.language, p.finish,
           pl.last_status, pl.last_attempt_at, pl.last_detail, pl.last_ok_price_jpy as last_ok_price, pl.last_ok_date::text as last_ok_date,
           (select candidates from price_history ph where ph.printing_id = t.printing_id and ph.source_id = ${sourceId}
             order by observed_date desc limit 1) as candidates,
           t.deck_names, sp.url as product_url, sp.match_status, sp.id as source_product_id
      from targets t
      join card_printings p on p.id = t.printing_id
      join cards c on c.id = p.card_id
      left join price_latest pl on pl.printing_id = t.printing_id and pl.source_id = ${sourceId}
      left join source_products sp on sp.printing_id = t.printing_id and sp.source_id = ${sourceId} and sp.match_status <> 'rejected'
     where (pl.last_status is null or pl.last_status <> 'ok')
       ${status === "never" ? db`and pl.last_status is null` : status ? db`and pl.last_status = ${status}` : db``}
     order by pl.last_status nulls first, c.name_en
     limit 500`;
}

export async function failedCountsByStatus(sourceId = DEFAULT_SOURCE) {
  const rows = await sql()<{ status: string | null; n: number }[]>`
    with targets as (
      select distinct dc.printing_id from deck_cards dc
       where dc.printing_id is not null and dc.section in ('commander','main') and not dc.is_basic_land)
    select pl.last_status as status, count(*)::int as n
      from targets t left join price_latest pl on pl.printing_id = t.printing_id and pl.source_id = ${sourceId}
     where pl.last_status is null or pl.last_status <> 'ok'
     group by pl.last_status`;
  return rows;
}

export async function reviewLines() {
  return sql()<{ id: string; deck_id: string; deck_name: string; language: string; card_name: string; quantity: number; section: string; note: string | null }[]>`
    select dc.id, dc.deck_id, d.name as deck_name, d.language, dc.card_name, dc.quantity, dc.section, dc.note
      from deck_cards dc join decks d on d.id = dc.deck_id
     where dc.resolution_status = 'needs_review' and dc.section in ('commander','main')
     order by d.name, dc.line_no limit 300`;
}

export async function anomalies(days = 7, sourceId = DEFAULT_SOURCE) {
  return sql()<{ printing_id: string; name_en: string; set_code: string; collector_number: string; language: string; finish: string; price_jpy: number; previous_price_jpy: number | null; observed_date: string }[]>`
    select ph.printing_id, c.name_en, p.set_code, p.collector_number, p.language, p.finish, ph.price_jpy, ph.previous_price_jpy, ph.observed_date::text
      from price_history ph join card_printings p on p.id = ph.printing_id join cards c on c.id = p.card_id
     where ph.source_id = ${sourceId} and ph.is_anomaly and ph.observed_date > (now() at time zone 'Asia/Tokyo')::date - ${days}::int
     order by ph.observed_date desc, abs(ph.price_jpy - coalesce(ph.previous_price_jpy, 0)) desc limit 100`;
}
