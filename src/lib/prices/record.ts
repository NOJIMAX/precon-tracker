import { getSetting, sql } from "../db";
import { jstDate } from "../time";
import type { Candidate } from "./match";
import type { LookupResult } from "./types";

export interface RecordInput {
  sourceId: string;
  printingId: string;
  result: LookupResult;
  method: "auto" | "csv" | "manual";
  jobId?: string | null;
  observedAt?: Date;
  /** CSV取込で商品URL等が分かっている場合 */
  product?: Candidate | null;
  /** 手動で確定した照合（confirmed）として紐づけるか */
  confirmMatch?: boolean;
}

export function isAnomalous(prev: number | null | undefined, next: number, thresholdPct: number, minPrice: number) {
  if (prev == null || prev === next) return false;
  if (Math.max(prev, next) < minPrice) return false;
  if (prev === 0) return true;
  return (Math.abs(next - prev) / prev) * 100 > thresholdPct;
}

async function upsertSourceProduct(sourceId: string, printingId: string, c: Candidate, status: "auto_exact" | "auto_unique" | "confirmed") {
  const db = sql();
  const [existing] = await db<{ id: string; match_status: string }[]>`
    select id, match_status from source_products where source_id = ${sourceId} and printing_id = ${printingId} and match_status <> 'rejected'`;
  if (existing) {
    // 手動確定済みの紐づけは自動結果で上書きしない
    if (existing.match_status === "confirmed" && status !== "confirmed") return existing.id;
    await db`update source_products set external_id = coalesce(${c.externalId ?? null}, external_id), url = coalesce(${c.url ?? null}, url),
               listed_name = ${c.name}, listed_set_code = ${c.setCode ?? null}, listed_number = ${c.collectorNumber ?? null},
               listed_language = ${c.language ?? null}, listed_finish = ${c.finish ?? null}, match_status = ${status}, matched_at = now()
             where id = ${existing.id}`;
    return existing.id;
  }
  const [row] = await db<{ id: string }[]>`
    insert into source_products (source_id, printing_id, external_id, url, listed_name, listed_set_code, listed_number, listed_language, listed_finish, match_status)
    values (${sourceId}, ${printingId}, ${c.externalId ?? null}, ${c.url ?? null}, ${c.name}, ${c.setCode ?? null},
            ${c.collectorNumber ?? null}, ${c.language ?? null}, ${c.finish ?? null}, ${status})
    returning id`;
  return row.id;
}

/**
 * 価格（または取得失敗）を1件記録します。
 * - 同じ日（日本時間）の記録は1件にまとめる（unique 制約）
 * - 同じ日に成功済みの記録は、後からの失敗で上書きしない
 * - 失敗は price_jpy = null で記録し、0円として扱わない
 * - 前回の成功価格から大きく動いた価格は is_anomaly = true
 */
export async function recordPrice(input: RecordInput) {
  const db = sql();
  const observedAt = input.observedAt ?? new Date();
  const observedDate = jstDate(observedAt);
  const r = input.result;
  const cand = input.product ?? r.candidate ?? null;
  let sourceProductId: string | null = null;
  if (cand && (input.confirmMatch || r.matchStatus)) {
    sourceProductId = await upsertSourceProduct(input.sourceId, input.printingId, cand, input.confirmMatch ? "confirmed" : r.matchStatus!);
  } else {
    const [sp] = await db<{ id: string }[]>`select id from source_products where source_id = ${input.sourceId} and printing_id = ${input.printingId} and match_status <> 'rejected'`;
    sourceProductId = sp?.id ?? null;
  }

  const [prev] = await db<{ price_jpy: number }[]>`
    select price_jpy from price_history
     where source_id = ${input.sourceId} and printing_id = ${input.printingId} and status = 'ok' and observed_date < ${observedDate}
     order by observed_date desc limit 1`;
  const price = r.status === "ok" ? (r.priceJpy ?? null) : null;
  if (r.status === "ok" && (price == null || !Number.isFinite(price) || price < 0)) throw new Error("取得成功なのに価格がありません");
  const threshold = Number(await getSetting("anomaly_threshold_pct", 50));
  const minPrice = Number(await getSetting("anomaly_min_price_jpy", 300));
  const anomaly = price != null && isAnomalous(prev?.price_jpy, price, threshold, minPrice);
  const candidates = r.candidates ? db.json(r.candidates as never) : null;

  const [row] = await db<{ id: string; status: string; price_jpy: number | null }[]>`
    insert into price_history (source_id, printing_id, source_product_id, price_jpy, status, observed_at, observed_date, method,
                               job_id, is_anomaly, previous_price_jpy, detail, candidates)
    values (${input.sourceId}, ${input.printingId}, ${sourceProductId}, ${price}, ${r.status}, ${observedAt}, ${observedDate},
            ${input.method}, ${input.jobId ?? null}, ${anomaly}, ${prev?.price_jpy ?? null}, ${r.detail ?? null}, ${candidates})
    on conflict (source_id, printing_id, observed_date) do update set
      source_product_id  = excluded.source_product_id,
      price_jpy          = excluded.price_jpy,
      status             = excluded.status,
      observed_at        = excluded.observed_at,
      method             = excluded.method,
      job_id             = excluded.job_id,
      is_anomaly         = excluded.is_anomaly,
      previous_price_jpy = excluded.previous_price_jpy,
      detail             = excluded.detail,
      candidates         = excluded.candidates
    where price_history.status <> 'ok' or excluded.status = 'ok'
    returning id, status, price_jpy`;
  return { id: row?.id ?? null, kept: !row, anomaly, previous: prev?.price_jpy ?? null };
}
