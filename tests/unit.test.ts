import { describe, expect, it } from "vitest";
import { parseDeckCsv } from "@/lib/decks/csv";
import { mergeOfficialWithMtgjson, mtgjsonDeckToParsed } from "@/lib/decks/mtgjson";
import { diffLines, validateDeck } from "@/lib/decks/validate";
import { parseWizardsDecklists } from "@/lib/decks/wizards";
import { fetchWithRetry, HttpError } from "@/lib/http";
import { parsePriceCsv } from "@/lib/prices/csvImport";
import { HareruyaAutoAdapter, parseHareruyaPurchaseSearch } from "@/lib/prices/hareruya";
import { matchCandidates, type PrintingTarget } from "@/lib/prices/match";
import { isAnomalous } from "@/lib/prices/record";
import { summarize, type DeckCardPriceRow } from "@/lib/prices/totals";
import { addDays, jstDate } from "@/lib/time";
import { sampleHareruyaHtml, sampleMtgjsonDeck, sampleWizardsHtml } from "./fixtures/sample";

describe("公式デッキリストの解析", () => {
  it("deck-list 要素から名前・枚数・統率者を読み取る", () => {
    const decks = parseWizardsDecklists(sampleWizardsHtml(), "https://magic.wizards.com/en/news/announcements/x?utm=1");
    expect(decks).toHaveLength(2);
    const d = decks[0];
    expect(d.name).toBe("World Tester");
    expect(d.sourceKey).toBe("wizards:https://magic.wizards.com/en/news/announcements/x#World Tester");
    expect(d.commanderNames).toEqual(["Tester, the Worldseed"]);
    expect(d.lines.find((l) => l.name === "Forest")?.quantity).toBe(10);
    expect(d.lines.every((l) => l.needsReview)).toBe(true); // 公式ページだけでは印刷仕様は未確定
    expect(decks[1].name).toBe("Other & Deck");
  });

  it("MTGJSON と重ねると印刷仕様が確定し、100枚の検証が通る", () => {
    const official = parseWizardsDecklists(sampleWizardsHtml(), "https://magic.wizards.com/en/x")[0];
    const mj = mtgjsonDeckToParsed(sampleMtgjsonDeck(), "WorldTester_TST");
    const merged = mergeOfficialWithMtgjson(official, mj);
    const v = validateDeck({ ...merged, category: "commander" });
    expect(v.countedTotal).toBe(100);
    expect(v.excludedTotal).toBe(2); // トークン・ディスプレイ用カードは含めない
    expect(v.ok).toBe(true);
    const cmd = merged.lines.find((l) => l.section === "commander")!;
    expect(cmd).toMatchObject({ setCode: "TST", collectorNumber: "1", finish: "foil", nameJa: "世界種、テスター" });
  });

  it("公式と MTGJSON が食い違うカードは確認待ちになる", () => {
    const official = parseWizardsDecklists(sampleWizardsHtml({ swap: true }), "https://magic.wizards.com/en/x")[0];
    const mj = mtgjsonDeckToParsed(sampleMtgjsonDeck(), "WorldTester_TST");
    const merged = mergeOfficialWithMtgjson(official, mj);
    const v = validateDeck({ ...merged, category: "commander" });
    expect(merged.lines.find((l) => l.name === "Mind Stone")?.needsReview).toBe(true);
    expect(v.ok).toBe(false);
    expect(merged.warnings.join()).toContain("Arcane Signet");
  });

  it("差分検知", () => {
    const a = [{ section: "main" as const, name: "Sol Ring", quantity: 1 }, { section: "main" as const, name: "Forest", quantity: 10 }];
    const b = [{ section: "main" as const, name: "Forest", quantity: 9 }, { section: "main" as const, name: "Mind Stone", quantity: 1 }];
    const d = diffLines(a, b);
    expect(d.added.map((x) => x.name)).toEqual(["Mind Stone"]);
    expect(d.removed.map((x) => x.name)).toEqual(["Sol Ring"]);
    expect(d.changed).toEqual([{ name: "Forest", section: "main", from: 10, to: 9 }]);
  });

  it("枚数が合わないデッキは検証エラー", () => {
    const mj = mtgjsonDeckToParsed(sampleMtgjsonDeck(), "f");
    mj.lines = mj.lines.filter((l) => l.name !== "Sol Ring");
    const v = validateDeck(mj);
    expect(v.countOk).toBe(false);
    expect(v.warnings[0]).toContain("99 枚");
  });
});

describe("デッキCSV", () => {
  it("仕様が欠けた行は確認待ち", () => {
    const d = parseDeckCsv("枚数,カード名,セット,番号,仕様,区分\n1,Tester,TST,1,foil,統率者\n1,Sol Ring,TST,,,\n", { name: "X" });
    expect(d.lines[0]).toMatchObject({ section: "commander", finish: "foil", needsReview: false });
    expect(d.lines[1]).toMatchObject({ section: "main", needsReview: true });
  });
});

describe("価格照合（別版を採用しない）", () => {
  const target: PrintingTarget = { name: "Sol Ring", setCode: "TST", collectorNumber: "57", language: "ja", finish: "nonfoil" };
  const cands = parseHareruyaPurchaseSearch(sampleHareruyaHtml(), "https://www.hareruyamtg.com/ja/purchase/search");

  it("晴れる屋の検索結果を読み取る", () => {
    expect(cands).toHaveLength(4);
    expect(cands[0]).toMatchObject({ name: "Sol Ring", setCode: "TST", collectorNumber: "57", language: "ja", finish: "nonfoil", priceJpy: 1200, externalId: "123456" });
    expect(cands[1].finish).toBe("foil");
    expect(cands[3]).toMatchObject({ language: "en", collectorNumber: null });
  });

  it("1. 完全一致を採用", () => {
    const m = matchCandidates(target, cands);
    expect(m.kind === "matched" && m.matchStatus === "auto_exact" && m.candidate.priceJpy).toBe(1200);
  });

  it("2. 番号が無い候補が一意なら採用、別番号の候補は採用しない", () => {
    const noNum = cands.map((c) => ({ ...c, collectorNumber: c.collectorNumber === "57" ? null : c.collectorNumber }));
    const m = matchCandidates(target, noNum);
    expect(m.kind === "matched" && m.matchStatus === "auto_unique" && m.candidate.priceJpy).toBe(1200);
    const onlyOther = cands.filter((c) => c.collectorNumber === "400");
    expect(matchCandidates(target, onlyOther).kind).toBe("none");
  });

  it("3. 候補が複数なら手動確認", () => {
    const dup = [{ ...cands[0], collectorNumber: null }, { ...cands[0], collectorNumber: null, externalId: "x" }];
    expect(matchCandidates(target, dup).kind).toBe("multiple");
  });

  it("4. 名前だけ一致（セット・言語違い）は取得失敗", () => {
    const m = matchCandidates({ ...target, setCode: "ZZZ" }, cands);
    expect(m.kind).toBe("none");
  });

  it("Foil と通常版を取り違えない", () => {
    const m = matchCandidates({ ...target, finish: "foil" }, cands);
    expect(m.kind === "matched" && m.candidate.priceJpy).toBe(3000);
  });

  it("自動取得アダプター: 間隔・上限・照合済み商品の再利用", async () => {
    let calls = 0;
    const waits: number[] = [];
    const a = new HareruyaAutoAdapter({
      minIntervalMs: 1000,
      maxRequests: 2,
      fetch: {
        fetchImpl: (async () => { calls++; return new Response(sampleHareruyaHtml()); }) as typeof fetch,
        sleep: async (ms) => { waits.push(ms); },
      },
    });
    const p = { printingId: "x", ...target };
    expect(await a.lookup(p)).toMatchObject({ status: "ok", priceJpy: 1200, matchStatus: "auto_exact" });
    expect(await a.lookup({ ...p, knownExternalId: "123458" })).toMatchObject({ status: "ok", priceJpy: 8000 });
    expect(waits.length).toBe(1);
    expect(await a.lookup(p)).toMatchObject({ status: "access_error" }); // 上限
    expect(calls).toBe(2);
  });
});

describe("価格CSV", () => {
  it("必須項目の欠落・価格なしを区別する", () => {
    const rows = parsePriceCsv("カード名,セット,番号,言語,仕様,買取価格\nSol Ring,TST,57,JP,通常,\"¥1,200\"\nX,TST,1,,foil,10\nY,TST,2,EN,foil,-\nZ,TST,3,EN,foil,\n");
    expect(rows[0]).toMatchObject({ priceJpy: 1200, language: "ja", finish: "nonfoil" });
    expect(rows[1].error).toContain("言語");
    expect(rows[2].priceJpy).toBeNull();
    expect(rows[2].error).toBeUndefined();
    expect(rows[2].blank).toBe(false);
    expect(rows[3]).toMatchObject({ blank: true, priceJpy: null });
  });
});

describe("集計", () => {
  const row = (o: Partial<DeckCardPriceRow>): DeckCardPriceRow => ({
    deck_card_id: "", line_no: 1, card_name: "", name_ja: null, quantity: 1, section: "main", is_basic_land: false,
    resolution_status: "resolved", note: null, printing_id: "p", set_code: null, collector_number: null, language: null,
    finish: null, variant: null, image_url: null, unit_price: null, price_date: null, price_observed_at: null, is_anomaly: null,
    prev_unit_price: null, last_status: null, last_attempt_at: null, last_detail: null, last_ok_price: null, last_ok_date: null,
    product_url: null, match_status: null, included: true, ...o,
  });
  it("未取得カードは合計に含めず、完全な合計として扱わない", () => {
    const t = summarize([row({ unit_price: 1000, quantity: 2 }), row({ unit_price: null }), row({ unit_price: 50, included: false })]);
    expect(t).toEqual({ total: 2000, pricedCount: 1, missingCount: 1, targetCount: 2, isComplete: false });
  });
  it("異常値判定", () => {
    expect(isAnomalous(1000, 2000, 50, 300)).toBe(true);
    expect(isAnomalous(1000, 1400, 50, 300)).toBe(false);
    expect(isAnomalous(50, 200, 50, 300)).toBe(false); // 低額カードは対象外
    expect(isAnomalous(null, 2000, 50, 300)).toBe(false);
  });
  it("日本時間の日付", () => {
    expect(jstDate(new Date("2026-11-08T21:00:00Z"))).toBe("2026-11-09");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("HTTP 再試行", () => {
  it("429/5xx は指数バックオフで再試行し、404 は再試行しない", async () => {
    const statuses = [503, 429, 200];
    const waits: number[] = [];
    const res = await fetchWithRetry("https://example.com", {
      fetchImpl: (async () => new Response("ok", { status: statuses.shift()! })) as typeof fetch,
      sleep: async (ms) => { waits.push(ms); },
      baseDelayMs: 100,
    });
    expect(res.status).toBe(200);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    let n = 0;
    await expect(
      fetchWithRetry("https://example.com", { fetchImpl: (async () => { n++; return new Response("", { status: 404 }); }) as typeof fetch }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(n).toBe(1);
  });
});
