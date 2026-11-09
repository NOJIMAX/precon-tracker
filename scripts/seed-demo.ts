/**
 * 画面確認用のデモデータを投入します（架空のデッキと30日分の価格）。本番DBには使わないでください。
 *   DATABASE_URL=<ローカルの確認用DB> npx tsx scripts/seed-demo.ts --yes
 */
import { closeDb, sql } from "../src/lib/db";
import { importOfficialUrl, refreshCatalog } from "../src/lib/decks/importer";
import { recordPrice } from "../src/lib/prices/record";
import { snapshotAllDecks } from "../src/lib/prices/totals";
import { addDays, jstDate } from "../src/lib/time";
import { sampleDeckListJson, sampleMtgjsonDeck, sampleWizardsHtml } from "../tests/fixtures/sample";

if (!process.argv.includes("--yes")) {
  console.error("デモデータを投入するには --yes を付けて実行してください（確認用DBのみ）");
  process.exit(1);
}
const URL_ = "https://magic.wizards.com/en/news/announcements/world-tester-commander-decklists";
globalThis.fetch = (async (input: string | URL) => {
  const u = String(input);
  if (u.endsWith("/DeckList.json")) return Response.json(sampleDeckListJson);
  if (u.includes("/decks/WorldTester_TST.json")) return Response.json({ data: sampleMtgjsonDeck() });
  if (u.startsWith(URL_)) return new Response(sampleWizardsHtml());
  return new Response("", { status: 404 });
}) as typeof fetch;

async function main() {
  await refreshCatalog();
  await importOfficialUrl(URL_, "ja");
  await importOfficialUrl(URL_, "en", { only: ["World Tester"] });
  const printings = await sql()<{ id: string; collector_number: string; language: string; finish: string }[]>`select id, collector_number, language, finish from card_printings`;
  const today = jstDate();
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const base = new Map(printings.map((p) => [p.id, Math.round((50 + rnd() * 600) * (p.finish === "foil" ? 4 : 1) * (p.language === "en" ? 0.8 : 1) / 10) * 10]));
  for (let d = 30; d >= 0; d--) {
    const date = addDays(today, -d);
    for (const p of printings) {
      if (Number(p.collector_number) >= 300) continue; // 基本土地
      if (p.collector_number === "170" || (p.collector_number === "171" && d < 3)) {
        await recordPrice({ sourceId: "hareruya_buyback", printingId: p.id, method: "auto", observedAt: new Date(`${date}T06:00:00+09:00`), result: { status: p.collector_number === "170" ? "not_found" : "multiple_candidates", detail: p.collector_number === "170" ? "同名のカードが検索結果にありません" : "2件の候補", candidates: p.collector_number === "171" ? [{ name: "Test Card 72", setCode: "TST", finish: "nonfoil", priceJpy: 120, url: "https://www.hareruyamtg.com/ja/purchase/product/1/" }, { name: "Test Card 72", setCode: "TST", finish: "nonfoil", priceJpy: 900, url: "https://www.hareruyamtg.com/ja/purchase/product/2/" }] : undefined } });
        continue;
      }
      const drift = 1 + (rnd() - 0.48) * 0.08;
      const v = Math.max(10, Math.round((base.get(p.id)! * drift) / 10) * 10);
      base.set(p.id, v);
      await recordPrice({ sourceId: "hareruya_buyback", printingId: p.id, method: "csv", observedAt: new Date(`${date}T06:00:00+09:00`), result: { status: "ok", priceJpy: v } });
    }
    await snapshotAllDecks(date);
  }
  console.log("demo data ready");
}
main().finally(closeDb);
