import Papa from "papaparse";
import { sql } from "../db";
import { parseFinish } from "../decks/csv";
import { nameKey, type Finish, type Language } from "../decks/types";
import { finishJob, logJob, startJob } from "../jobs/jobs";
import { recordPrice } from "./record";

/**
 * 買取価格CSVの取り込み（晴れる屋の自動取得を使わない運用の標準手段）。
 *
 *   カード名,セット,番号,言語,仕様,買取価格,URL,取得日時
 *   Sol Ring,EOC,57,JP,nonfoil,300,https://www.hareruyamtg.com/ja/purchase/...,2026-11-09 10:00
 *
 * - カード名・セット・言語・仕様は必須。番号は推奨（無い場合は登録済みの版から一意に決まるときだけ採用）
 * - 買取価格が「-」「なし」の行は「価格非公開」として記録（0円にはしない）
 * - 買取価格が空欄の行は未入力として読み飛ばす（テンプレートの入力途中でも取り込めるように）
 * - 照合できない行は取り込まず、結果に理由を返します
 */
const COLS: Record<string, string[]> = {
  name: ["name", "card_name", "カード名", "英語名"],
  set: ["set", "set_code", "セット", "セット記号"],
  number: ["number", "collector_number", "番号", "コレクター番号"],
  language: ["language", "lang", "言語"],
  finish: ["finish", "foil", "仕様"],
  price: ["price", "price_jpy", "buyback", "買取価格", "価格"],
  url: ["url", "商品url", "product_url"],
  externalId: ["external_id", "product_id", "商品id"],
  observedAt: ["observed_at", "取得日時", "日時"],
};

export function parseLanguage(v?: string | null): Language | null {
  const s = (v ?? "").trim().toLowerCase();
  if (["ja", "jp", "日本語", "japanese"].includes(s)) return "ja";
  if (["en", "英語", "english"].includes(s)) return "en";
  return null;
}

export interface PriceCsvRow {
  rowNo: number;
  name: string;
  setCode: string | null;
  collectorNumber: string | null;
  language: Language | null;
  finish: Finish | null;
  priceJpy: number | null;
  url: string | null;
  externalId: string | null;
  observedAt: Date | null;
  /** 買取価格が空欄（未入力） */
  blank?: boolean;
  error?: string;
}

export function parsePriceCsv(text: string): PriceCsvRow[] {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  return parsed.data.map((row, i) => {
    const pick = (k: keyof typeof COLS) => {
      for (const c of COLS[k]) if (row[c] !== undefined && row[c] !== null) return String(row[c]).trim();
      return "";
    };
    const priceRaw = pick("price").replace(/[¥￥,円\s]/g, "");
    const blank = priceRaw === "";
    const priceJpy = blank || ["-", "－", "なし", "掲載なし"].includes(priceRaw) ? null : Number(priceRaw);
    const obs = pick("observedAt");
    const observedAt = obs ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(obs) ? obs : obs.replace(" ", "T") + "+09:00") : null;
    const r: PriceCsvRow = {
      rowNo: i + 2,
      name: pick("name"),
      setCode: pick("set").toUpperCase() || null,
      collectorNumber: pick("number") || null,
      language: parseLanguage(pick("language")),
      finish: parseFinish(pick("finish")),
      priceJpy,
      url: pick("url") || null,
      externalId: pick("externalId") || null,
      observedAt: observedAt && !isNaN(observedAt.getTime()) ? observedAt : null,
      blank,
    };
    const missing = [!r.name && "カード名", !r.setCode && "セット", !r.language && "言語", !r.finish && "仕様"].filter(Boolean);
    if (missing.length) r.error = `${missing.join("・")}がありません`;
    else if (priceJpy !== null && (!Number.isInteger(priceJpy) || priceJpy < 0)) r.error = `買取価格「${pick("price")}」を数値として読めません`;
    else if (obs && !r.observedAt) r.error = `取得日時「${obs}」を読めません`;
    return r;
  });
}

async function findPrinting(r: PriceCsvRow): Promise<{ id?: string; error?: string }> {
  const db = sql();
  if (r.collectorNumber) {
    const rows = await db<{ id: string; name_en: string }[]>`
      select p.id, c.name_en from card_printings p join cards c on c.id = p.card_id
       where p.set_code = ${r.setCode} and p.collector_number = ${r.collectorNumber} and p.language = ${r.language} and p.finish = ${r.finish}`;
    if (!rows.length) return { error: "登録済みデッキに該当するカード版がありません" };
    if (nameKey(rows[0].name_en) !== nameKey(r.name)) return { error: `セット・番号は一致するがカード名が異なります（登録: ${rows[0].name_en}）` };
    return { id: rows[0].id };
  }
  const rows = await db<{ id: string; name_en: string }[]>`
    select p.id, c.name_en from card_printings p join cards c on c.id = p.card_id
     where p.set_code = ${r.setCode} and p.language = ${r.language} and p.finish = ${r.finish}`;
  const hits = rows.filter((x) => nameKey(x.name_en) === nameKey(r.name));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `同じセット・仕様の版が${hits.length}種類あるため番号が必要です` };
  return { error: "登録済みデッキに該当するカード版がありません" };
}

export async function importPriceCsv(text: string, opts: { sourceId?: string; trigger?: string } = {}) {
  const sourceId = opts.sourceId ?? "hareruya_buyback";
  const rows = parsePriceCsv(text);
  const job = await startJob("import", opts.trigger ?? "button");
  if (!job) throw new Error("別の取り込みが実行中です。完了してからもう一度お試しください");
  const results: { rowNo: number; name: string; status: "imported" | "kept" | "skipped"; message?: string }[] = [];
  let ok = 0, failed = 0, blank = 0;
  try {
    for (const r of rows) {
      if (r.blank) {
        blank++;
        continue;
      }
      if (r.error) {
        results.push({ rowNo: r.rowNo, name: r.name, status: "skipped", message: r.error });
        failed++;
        continue;
      }
      const p = await findPrinting(r);
      if (!p.id) {
        results.push({ rowNo: r.rowNo, name: r.name, status: "skipped", message: p.error });
        failed++;
        continue;
      }
      const product = r.url || r.externalId
        ? { name: r.name, setCode: r.setCode, collectorNumber: r.collectorNumber, language: r.language, finish: r.finish, url: r.url, externalId: r.externalId }
        : null;
      const rec = await recordPrice({
        sourceId,
        printingId: p.id,
        method: "csv",
        jobId: job,
        observedAt: r.observedAt ?? undefined,
        product,
        confirmMatch: !!product,
        result: r.priceJpy === null ? { status: "not_listed", detail: "CSVで価格なし" } : { status: "ok", priceJpy: r.priceJpy },
      });
      results.push({
        rowNo: r.rowNo,
        name: r.name,
        status: rec.kept ? "kept" : "imported",
        message: rec.kept ? "同じ日の成功価格があるため上書きしませんでした" : rec.anomaly ? `前回 ¥${rec.previous?.toLocaleString()} から大きく変動（要確認）` : undefined,
      });
      ok++;
    }
    for (const r of results.filter((x) => x.status !== "imported" || x.message)) {
      await logJob(job, { level: r.status === "skipped" ? "warn" : "info", message: `${r.rowNo}行目 ${r.name}: ${r.message ?? r.status}` });
    }
    await logJob(job, { level: "info", message: `CSV取込: ${ok}件取込 / ${failed}件スキップ / ${blank}件は価格未入力` });
    await finishJob(job, { success: ok, failure: failed, target: rows.length - blank });
  } catch (e) {
    await finishJob(job, { success: ok, failure: failed, target: rows.length, error: (e as Error).message });
    throw e;
  }
  return { jobId: job, imported: ok, skipped: failed, blank, results };
}
