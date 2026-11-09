/**
 * データベースを使った通し試験（指示書 13章の実証項目 1〜6 の流れ）。
 * TEST_DATABASE_URL のデータベースを毎回作り直します。本番DBは使いません。
 * 外部サイトへのアクセスは fetch を差し替えて合成データを返します。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { migrate } from "../scripts/migrate";
import { closeDb, setSetting, sql } from "@/lib/db";
import { checkDeckForChanges, importMtgjsonDeck, importOfficialUrl, refreshCatalog } from "@/lib/decks/importer";
import { resolveDeckCard } from "@/lib/decks/store";
import { runPriceUpdate } from "@/lib/jobs/daily";
import { startJob } from "@/lib/jobs/jobs";
import { importPriceCsv } from "@/lib/prices/csvImport";
import { recordPrice } from "@/lib/prices/record";
import { deckCardPrices, deckSummaries, summarize } from "@/lib/prices/totals";
import type { PriceAdapter } from "@/lib/prices/types";
import { sampleDeckListJson, sampleMtgjsonDeck, sampleWizardsHtml } from "./fixtures/sample";

const URL_ = "https://magic.wizards.com/en/news/announcements/world-tester-commander-decklists";
let wizardsHtml = sampleWizardsHtml();

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL!;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe("drop schema if exists public cascade; create schema public;");
  await admin.end();
  await migrate(url, () => {});
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const u = String(input);
    if (u.endsWith("/DeckList.json")) return Response.json(sampleDeckListJson);
    if (u.includes("/decks/WorldTester_TST.json")) return Response.json({ data: sampleMtgjsonDeck() });
    if (u.startsWith(URL_)) return new Response(wizardsHtml);
    return new Response("not found", { status: 404 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await closeDb();
});

const D1 = "2026-11-09";
const D2 = "2026-11-10";
let deckId = "";

const csvHeader = "カード名,セット,番号,言語,仕様,買取価格,URL,取得日時\n";
function priceCsv(day: string, solRing: number, extra = "") {
  const rows = [
    `"Tester, the Worldseed",TST,1,JP,foil,5000,https://www.hareruyamtg.com/ja/purchase/product/900001/,${day} 09:00`,
    `Sol Ring,TST,57,JP,nonfoil,${solRing},,${day} 09:00`,
    `Arcane Signet,TST,58,JP,nonfoil,-,,${day} 09:00`,
  ];
  // 78枚の通常カードのうち 70 枚にだけ価格を付ける（8枚は未取得のまま）
  for (let i = 0; i < 70; i++) rows.push(`Test Card ${String(i + 1).padStart(2, "0")},TST,${100 + i},JP,nonfoil,100,,${day} 09:00`);
  return csvHeader + rows.join("\n") + extra;
}

describe("実証 1〜3: 公式デッキの取得・保存・印刷仕様の識別", () => {
  it("カタログを保存できる", async () => {
    expect(await refreshCatalog()).toBe(2);
  });

  it("公式URLからデッキを取り込み、100枚・統率者・印刷仕様を確定できる", async () => {
    const res = await importOfficialUrl(URL_, "ja", { only: ["World Tester"] });
    expect(res).toHaveLength(1);
    expect(res[0].error).toBeUndefined();
    expect(res[0].ok).toBe(true);
    deckId = res[0].deckId!;
    const [deck] = await sql()`select * from decks where id = ${deckId}`;
    expect(deck).toMatchObject({ status: "ok", set_code: "TST", language: "ja", source: "wizards", mtgjson_file: "WorldTester_TST" });
    expect(deck.commander_names).toEqual(["Tester, the Worldseed"]);
    const [{ total }] = await sql()`select sum(quantity)::int as total from deck_cards where deck_id = ${deckId} and section in ('commander','main')`;
    expect(total).toBe(100);
    const [cmd] = await sql()`select p.set_code, p.collector_number, p.finish, p.language, c.name_ja
      from deck_cards dc join card_printings p on p.id = dc.printing_id join cards c on c.id = p.card_id
      where dc.deck_id = ${deckId} and dc.section = 'commander'`;
    expect(cmd).toEqual({ set_code: "TST", collector_number: "1", finish: "foil", language: "ja", name_ja: "世界種、テスター" });
  });

  it("同じデッキは重複登録できない（公式・MTGJSON どちらから登録しても）", async () => {
    const again = await importOfficialUrl(URL_, "ja", { only: ["World Tester"] });
    expect(again[0].error).toContain("登録済み");
    await expect(importMtgjsonDeck("WorldTester_TST", "ja")).rejects.toThrow("登録済み");
    // 言語が違えば別デッキ（英語版）として登録できる
    const en = await importMtgjsonDeck("WorldTester_TST", "en");
    expect(en.deckId).not.toBe(deckId);
  });

  it("MTGJSONに無い公式デッキは確認待ちとして保存し、手動で確定できる", async () => {
    const res = await importOfficialUrl(URL_, "ja", { only: ["Other & Deck"] });
    const [d] = await sql()`select status from decks where id = ${res[0].deckId!}`;
    expect(d.status).toBe("needs_review");
    const [line] = await sql()`select id, resolution_status from deck_cards where deck_id = ${res[0].deckId!}`;
    expect(line.resolution_status).toBe("needs_review");
    await resolveDeckCard(line.id, { setCode: "tst", collectorNumber: "57", finish: "nonfoil" });
    const [after] = await sql()`select resolution_status, printing_id from deck_cards where id = ${line.id}`;
    expect(after.resolution_status).toBe("resolved");
  });
});

describe("実証 4〜5: 買取価格の取り込みとデッキ合計", () => {
  it("CSVで取り込み、照合できない行は取り込まない", async () => {
    const r = await importPriceCsv(priceCsv(D1, 1200, "\nSol Ring,ZZZ,57,JP,nonfoil,999,,\nSol Ring,TST,57,EN,foil,10,,\nTest Card 75,TST,174,JP,nonfoil,,,"));
    expect(r.blank).toBe(1);
    expect(r.imported).toBe(73);
    expect(r.skipped).toBe(2);
    expect(r.results.find((x) => x.status === "skipped")?.message).toContain("該当するカード版がありません");
  });

  it("価格が揃っていないデッキは小計と未取得数を出し、完全な合計にしない", async () => {
    const rows = await deckCardPrices(deckId, D1);
    const t = summarize(rows);
    // 統率者5000 + Sol Ring 1200 + 70枚×100 = 13,200（Arcane Signet は価格非公開、8枚は未取得、基本土地は除外）
    expect(t.total).toBe(13200);
    expect(t.targetCount).toBe(81);
    expect(t.missingCount).toBe(9);
    expect(t.isComplete).toBe(false);
    const signet = rows.find((r) => r.card_name === "Arcane Signet")!;
    expect(signet.unit_price).toBeNull();
    expect(signet.last_status).toBe("not_listed");
    const cmd = rows.find((r) => r.section === "commander")!;
    expect(cmd.product_url).toContain("900001");
    expect(cmd.match_status).toBe("confirmed");
  });

  it("同じ日の再取込で履歴が重複しない", async () => {
    await importPriceCsv(priceCsv(D1, 1200));
    const [{ n }] = await sql()`select count(*)::int as n from price_history ph join card_printings p on p.id = ph.printing_id
      where p.set_code = 'TST' and p.collector_number = '57' and p.language = 'ja' and ph.observed_date = ${D1}`;
    expect(n).toBe(1);
  });

  it("基本土地の扱いを設定で切り替えられる", async () => {
    await setSetting("basic_land_policy", "include_if_priced");
    await importPriceCsv(`${csvHeader}Forest,TST,300,JP,nonfoil,10,,${D1} 09:00`);
    expect(summarize(await deckCardPrices(deckId, D1)).total).toBe(13300);
    await setSetting("basic_land_policy", "exclude");
    expect(summarize(await deckCardPrices(deckId, D1)).total).toBe(13200);
  });
});

describe("実証 6: 翌日の価格と前日比", () => {
  it("日次集計を2日分作り、前日比を計算できる", async () => {
    const r1 = await runPriceUpdate({ today: D1, adapter: null, deckChecksPerRun: 0, trigger: "test" });
    expect(r1).toMatchObject({ skipped: false, status: "succeeded" });
    // 翌日: Sol Ring が 1,200 → 2,000（異常値判定の対象）。他のカードは前日の価格をそのまま使う
    const imp = await importPriceCsv(priceCsv(D2, 2000));
    expect(imp.results.find((x) => x.name === "Sol Ring")?.message).toContain("大きく変動");
    await runPriceUpdate({ today: D2, adapter: null, deckChecksPerRun: 0, trigger: "test" });
    const s = (await deckSummaries([deckId])).get(deckId)!;
    expect(s.total).toBe(14000);
    expect(s.d1).toMatchObject({ yen: 800, baseDate: D1, comparable: false });
    expect(s.d1!.pct).toBeCloseTo(6.06, 1);
    expect(s.successRate).toBeCloseTo(72 / 81, 5);
    const rows = await deckCardPrices(deckId, D2);
    const sol = rows.find((r) => r.card_name === "Sol Ring")!;
    expect(sol).toMatchObject({ unit_price: 2000, prev_unit_price: 1200, is_anomaly: true });
  });
});

describe("定期更新（自動取得アダプター使用時）", () => {
  it("失敗を0円にせず、一時エラーは再試行し、成功価格を失敗で上書きしない", async () => {
    const seen = new Map<string, number>();
    const adapter: PriceAdapter = {
      sourceId: "hareruya_buyback",
      async lookup(p) {
        const n = (seen.get(p.printingId) ?? 0) + 1;
        seen.set(p.printingId, n);
        if (p.name === "Sol Ring") return { status: "ok", priceJpy: 2100, matchStatus: "auto_exact", candidate: { name: p.name, setCode: p.setCode, collectorNumber: p.collectorNumber, language: p.language, finish: p.finish } };
        if (p.name === "Test Card 01") return n === 1 ? { status: "access_error", detail: "HTTP 503" } : { status: "ok", priceJpy: 150 };
        if (p.name === "Test Card 02") return { status: "access_error", detail: "HTTP 503" };
        if (p.name === "Test Card 03") return { status: "multiple_candidates", candidates: [{ name: "a" }, { name: "b" }] };
        if (p.name === "Test Card 04") throw new Error("想定外の例外");
        return { status: "not_found", detail: "検索結果なし" };
      },
    };
    const r = await runPriceUpdate({ today: D2, adapter, deckChecksPerRun: 0, retryDelayMs: 0, trigger: "test" });
    // 再試行は Test Card 01/02 の日本語版・英語版の 4 件
    expect(r).toMatchObject({ status: "partial", retries: 4 });
    // 同じ印刷版は1回だけ（再試行分を除く）。英語版デッキの版も含む
    const [{ n }] = await sql()`select count(distinct printing_id)::int as n from deck_cards where printing_id is not null and section in ('commander','main') and not is_basic_land`;
    expect(seen.size).toBe(n);
    expect([...seen.values()].filter((v) => v > 1)).toHaveLength(4);
    const rows = await deckCardPrices(deckId, D2);
    const get = (n: string) => rows.find((x) => x.card_name === n)!;
    expect(get("Sol Ring").unit_price).toBe(2100);
    expect(get("Test Card 01").unit_price).toBe(150); // 再試行で成功
    // D2 は CSV で 100 円の成功記録がある → 失敗では上書きしない
    expect(get("Test Card 02")).toMatchObject({ unit_price: 100, last_status: "ok" });
    const [failed] = await sql()`select price_jpy, status from price_history ph join card_printings p on p.id = ph.printing_id join cards c on c.id = p.card_id
      where c.name_en = 'Test Card 75' and p.language = 'ja' and ph.observed_date = ${D2}`;
    expect(failed).toEqual({ price_jpy: null, status: "not_found" });
    const [mapped] = await sql()`select match_status from source_products sp join card_printings p on p.id = sp.printing_id join cards c on c.id = p.card_id where c.name_en = 'Sol Ring' and p.language = 'ja' and p.finish = 'nonfoil' and p.set_code = 'TST'`;
    expect(mapped.match_status).toBe("auto_exact");
  });

  it("二重実行を防止する", async () => {
    const id = await startJob("daily", "test");
    expect(id).toBeTruthy();
    expect(await startJob("daily", "test")).toBeNull();
    expect((await runPriceUpdate({ kind: "manual", adapter: null, trigger: "test" })).skipped).toBe(true);
    await sql()`update update_jobs set status = 'failed', finished_at = now() where id = ${id}`;
  });

  it("失敗を直接記録しても 0 円にはならない", async () => {
    const [p] = await sql()`select id from card_printings limit 1`;
    await recordPrice({ sourceId: "hareruya_buyback", printingId: p.id, method: "auto", observedAt: new Date("2026-11-11T00:00:00Z"), result: { status: "parse_error" } });
    const [row] = await sql()`select price_jpy from price_history where printing_id = ${p.id} and observed_date = '2026-11-11'`;
    expect(row.price_jpy).toBeNull();
  });
});

describe("公式デッキリストの変更検知", () => {
  it("変更が無ければ何もしない／変更があれば差分を記録し確認待ちにする", async () => {
    expect((await checkDeckForChanges(deckId)).changed).toBe(false);
    wizardsHtml = sampleWizardsHtml({ swap: true });
    const r = await checkDeckForChanges(deckId);
    expect(r.changed).toBe(true);
    const [d] = await sql()`select status, diff_detected_at from decks where id = ${deckId}`;
    expect(d.status).toBe("needs_review");
    expect(d.diff_detected_at).not.toBeNull();
  });
});
