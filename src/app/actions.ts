"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setSetting, sql } from "@/lib/db";
import { parseDeckCsv } from "@/lib/decks/csv";
import { checkDeckForChanges, importMtgjsonDeck, importOfficialUrl, refreshCatalog } from "@/lib/decks/importer";
import { DuplicateDeckError, resolveDeckCard, saveDeck } from "@/lib/decks/store";
import type { Finish, Language } from "@/lib/decks/types";
import { activeAdapter, runPriceUpdate } from "@/lib/jobs/daily";
import { importPriceCsv } from "@/lib/prices/csvImport";
import { recordPrice } from "@/lib/prices/record";
import { DEFAULT_SOURCE, snapshotAllDecks } from "@/lib/prices/totals";
import { jstDate } from "@/lib/time";

function back(path: string, msg: string, kind: "msg" | "err" = "msg"): never {
  const [base, hash] = path.split("#");
  const sep = base.includes("?") ? "&" : "?";
  redirect(`${base}${sep}${kind}=${encodeURIComponent(msg)}${hash ? `#${hash}` : ""}`);
}

const lang = (v: FormDataEntryValue | null): Language => (v === "en" ? "en" : "ja");
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");
async function textOf(fd: FormData, fileField: string, textField: string) {
  const f = fd.get(fileField);
  if (f && typeof f !== "string" && f.size > 0) {
    if (f.size > 5 * 1024 * 1024) throw new Error("ファイルが大きすぎます（5MBまで）");
    return await f.text();
  }
  return str(fd.get(textField));
}

// ───────── デッキ ─────────

export async function refreshCatalogAction() {
  let n: number;
  try {
    n = await refreshCatalog();
  } catch (e) {
    back("/decks/search", `デッキ一覧の取得に失敗しました: ${(e as Error).message}`, "err");
  }
  revalidatePath("/decks/search");
  back("/decks/search", `MTGJSONのデッキ一覧を更新しました（${n}件）`);
}

export async function registerMtgjsonAction(fd: FormData) {
  const files = fd.getAll("file").map(String).filter(Boolean);
  const language = lang(fd.get("language"));
  const ret = str(fd.get("return")) || "/decks/search";
  if (!files.length) back(ret, "登録するデッキを選んでください", "err");
  const ok: string[] = [], ng: string[] = [];
  for (const f of files) {
    try {
      await importMtgjsonDeck(f, language);
      ok.push(f);
    } catch (e) {
      ng.push(`${f}: ${(e as Error).message}`);
    }
  }
  await snapshotAllDecks();
  revalidatePath("/");
  back(ret, `${ok.length}件登録しました${ng.length ? ` ／ ${ng.length}件失敗（${ng.join("、")}）` : ""}`, ng.length && !ok.length ? "err" : "msg");
}

export async function registerOfficialAction(fd: FormData) {
  const url = str(fd.get("url"));
  const only = fd.getAll("deck").map(String);
  const setCode = str(fd.get("set_code")) || null;
  const ret = `/decks/search?url=${encodeURIComponent(url)}${setCode ? `&set=${encodeURIComponent(setCode)}` : ""}`;
  if (!only.length) back(ret, "登録するデッキを選んでください", "err");
  let results;
  try {
    results = await importOfficialUrl(url, lang(fd.get("language")), { setCode, only });
  } catch (e) {
    back(ret, (e as Error).message, "err");
  }
  await snapshotAllDecks();
  revalidatePath("/");
  const ok = results.filter((r) => r.deckId && !r.error);
  const ng = results.filter((r) => r.error);
  const review = ok.filter((r) => !r.ok).length;
  back(ret, `${ok.length}件登録しました${review ? `（うち${review}件は確認待ち）` : ""}${ng.length ? ` ／ ${ng.map((r) => `${r.name}: ${r.error}`).join("、")}` : ""}`, ng.length && !ok.length ? "err" : "msg");
}

export async function importDeckCsvAction(fd: FormData) {
  const name = str(fd.get("name"));
  if (!name) back("/decks/search", "デッキ名を入力してください", "err");
  let deckId: string;
  try {
    const text = await textOf(fd, "file", "text");
    if (!text) throw new Error("CSVを指定してください");
    const parsed = parseDeckCsv(text, {
      name,
      setCode: str(fd.get("set_code")) || null,
      expectedCardCount: Number(fd.get("expected")) || 100,
      category: (str(fd.get("category")) || "commander") as never,
    });
    parsed.officialUrl = str(fd.get("official_url")) || null;
    deckId = (await saveDeck(parsed, lang(fd.get("language")))).deckId;
  } catch (e) {
    if (e instanceof DuplicateDeckError) redirect(`/decks/${e.deckId}?err=${encodeURIComponent(e.message)}`);
    back("/decks/search", (e as Error).message, "err");
  }
  await snapshotAllDecks();
  redirect(`/decks/${deckId}?msg=${encodeURIComponent("CSVからデッキを登録しました")}`);
}

export async function recheckDeckAction(fd: FormData) {
  const id = str(fd.get("deck_id"));
  let r;
  try {
    r = await checkDeckForChanges(id);
  } catch (e) {
    back(`/decks/${id}`, `確認に失敗しました: ${(e as Error).message}`, "err");
  }
  revalidatePath(`/decks/${id}`);
  back(`/decks/${id}`, "skipped" in r ? "公式URL・MTGJSONの情報が無いため確認できません" : r.changed ? "公式リストとの差分を検知しました" : "公式リストと一致しています");
}

export async function clearDeckDiffAction(fd: FormData) {
  const id = str(fd.get("deck_id"));
  await sql().begin(async (tx) => {
    await tx`update decks set diff_detected_at = null where id = ${id}`;
    const { refreshDeckStatus } = await import("@/lib/decks/store");
    await refreshDeckStatus(tx, id);
  });
  back(`/decks/${id}`, "差分を確認済みにしました");
}

export async function deleteDeckAction(fd: FormData) {
  const id = str(fd.get("deck_id"));
  if (str(fd.get("confirm")) !== "削除") back(`/decks/${id}`, "確認欄に「削除」と入力してください", "err");
  await sql()`delete from decks where id = ${id}`;
  revalidatePath("/");
  back("/", "デッキを削除しました");
}

export async function resolveLineAction(fd: FormData) {
  const id = str(fd.get("deck_card_id"));
  const ret = str(fd.get("return")) || "/admin";
  const finish = str(fd.get("finish")) as Finish;
  if (!["nonfoil", "foil", "etched"].includes(finish) || !str(fd.get("set_code")) || !str(fd.get("number"))) {
    back(ret, "セット・番号・仕様をすべて入力してください", "err");
  }
  try {
    await resolveDeckCard(id, { setCode: str(fd.get("set_code")), collectorNumber: str(fd.get("number")), finish });
  } catch (e) {
    back(ret, (e as Error).message, "err");
  }
  await snapshotAllDecks();
  back(ret, "印刷仕様を確定しました");
}

// ───────── 価格 ─────────

export async function importPriceCsvAction(fd: FormData) {
  let r;
  try {
    const text = await textOf(fd, "file", "text");
    if (!text) throw new Error("CSVを指定してください");
    r = await importPriceCsv(text, { trigger: "button" });
    await snapshotAllDecks();
  } catch (e) {
    back("/prices/import", (e as Error).message, "err");
  }
  revalidatePath("/");
  back(`/prices/import?job=${r.jobId}`, `${r.imported}件取り込みました${r.skipped ? ` ／ ${r.skipped}件は取り込めませんでした（下の一覧を確認）` : ""}`);
}

export async function manualPriceAction(fd: FormData) {
  const printingId = str(fd.get("printing_id"));
  const ret = str(fd.get("return")) || "/admin";
  const raw = str(fd.get("price")).replace(/[¥￥,円\s]/g, "");
  const date = str(fd.get("date")) || jstDate();
  const notListed = fd.get("not_listed") === "on";
  const price = Number(raw);
  if (!notListed && (!raw || !Number.isInteger(price) || price < 0)) back(ret, "買取価格を0以上の整数で入力してください", "err");
  await recordPrice({
    sourceId: DEFAULT_SOURCE,
    printingId,
    method: "manual",
    observedAt: date === jstDate() ? new Date() : new Date(`${date}T12:00:00+09:00`),
    result: notListed ? { status: "not_listed", detail: "手入力（価格なし）" } : { status: "ok", priceJpy: price },
  });
  await snapshotAllDecks(date);
  if (date !== jstDate()) await snapshotAllDecks();
  revalidatePath("/");
  back(ret, "価格を記録しました");
}

export async function linkProductAction(fd: FormData) {
  const printingId = str(fd.get("printing_id"));
  const url = str(fd.get("url"));
  const ret = str(fd.get("return")) || "/admin";
  let u: URL;
  try {
    u = new URL(url);
    if (u.hostname !== "www.hareruyamtg.com") throw new Error();
  } catch {
    back(ret, "晴れる屋（www.hareruyamtg.com）の商品URLを入力してください", "err");
  }
  const externalId = /\/(\d+)(?:[/?#]|$)/.exec(u.pathname)?.[1] ?? null;
  await sql().begin(async (tx) => {
    await tx`update source_products set match_status = 'rejected', note = '手動で別の商品に付け替え'
              where source_id = ${DEFAULT_SOURCE} and printing_id = ${printingId} and match_status <> 'rejected'`;
    const [p] = await tx<{ name_en: string; set_code: string; collector_number: string; language: string; finish: string }[]>`
      select c.name_en, p.set_code, p.collector_number, p.language, p.finish from card_printings p join cards c on c.id = p.card_id where p.id = ${printingId}`;
    await tx`insert into source_products (source_id, printing_id, external_id, url, listed_name, listed_set_code, listed_number, listed_language, listed_finish, match_status, note)
             values (${DEFAULT_SOURCE}, ${printingId}, ${externalId}, ${u.toString()}, ${p.name_en}, ${p.set_code}, ${p.collector_number}, ${p.language}, ${p.finish}, 'confirmed', '手動で紐づけ')`;
  });
  back(ret, "商品URLを紐づけました（次回以降の取得・CSV照合で使われます）");
}

/** 誤照合の修正: 紐づけを外し、その紐づけで記録した価格を「照合確認待ち」に戻す */
export async function rejectMatchAction(fd: FormData) {
  const id = str(fd.get("source_product_id"));
  const ret = str(fd.get("return")) || "/admin";
  await sql().begin(async (tx) => {
    await tx`update source_products set match_status = 'rejected', note = '誤照合として除外' where id = ${id}`;
    await tx`update price_history set status = 'pending_review', price_jpy = null, detail = '誤照合として除外'
              where source_product_id = ${id} and method = 'auto'`;
  });
  await snapshotAllDecks();
  back(ret, "紐づけを外し、その商品で記録した自動取得価格を無効にしました");
}

export async function runManualUpdateAction() {
  const r = await runPriceUpdate({ kind: "manual", trigger: "button" });
  revalidatePath("/");
  if (r.skipped) back("/admin", r.reason, "err");
  back("/admin", `更新しました（成功 ${r.success} ／ 失敗 ${r.failure}）`);
}

export async function retryCardAction(fd: FormData) {
  const printingId = str(fd.get("printing_id"));
  const adapter = await activeAdapter();
  if (!adapter) back("/admin", "自動取得が無効のため再取得できません。CSV取込か手入力で登録してください", "err");
  const [p] = await sql()<{ name_en: string; set_code: string; collector_number: string; language: Language; finish: Finish; external_id: string | null; url: string | null }[]>`
    select c.name_en, p.set_code, p.collector_number, p.language, p.finish, sp.external_id, sp.url
      from card_printings p join cards c on c.id = p.card_id
      left join source_products sp on sp.printing_id = p.id and sp.source_id = ${DEFAULT_SOURCE} and sp.match_status <> 'rejected'
     where p.id = ${printingId}`;
  const r = await adapter.lookup({ printingId, name: p.name_en, setCode: p.set_code, collectorNumber: p.collector_number, language: p.language, finish: p.finish, knownExternalId: p.external_id, knownUrl: p.url });
  await recordPrice({ sourceId: DEFAULT_SOURCE, printingId, result: r, method: "auto" });
  await snapshotAllDecks();
  back("/admin", `再取得: ${p.name_en} → ${r.status === "ok" ? `¥${r.priceJpy?.toLocaleString()}` : r.status}`);
}

export async function saveSettingsAction(fd: FormData) {
  const policy = str(fd.get("basic_land_policy"));
  const maxAge = Number(fd.get("price_max_age_days"));
  const thr = Number(fd.get("anomaly_threshold_pct"));
  const minP = Number(fd.get("anomaly_min_price_jpy"));
  if (!["exclude", "include_if_priced"].includes(policy) || !(maxAge >= 1 && maxAge <= 365) || !(thr > 0) || !(minP >= 0)) {
    back("/admin", "設定値が不正です", "err");
  }
  await setSetting("basic_land_policy", policy);
  await setSetting("price_max_age_days", maxAge);
  await setSetting("anomaly_threshold_pct", thr);
  await setSetting("anomaly_min_price_jpy", minP);
  await snapshotAllDecks();
  back("/admin", "設定を保存し、今日の合計を再計算しました");
}
