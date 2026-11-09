/**
 * テスト用の合成データ（実在の製品名を模した架空のデッキ）。
 * 実際の公式ページ・MTGJSON・晴れる屋の形式に合わせて作っていますが、内容は本物ではありません。
 */
import type { MtgjsonCard, MtgjsonDeck } from "@/lib/decks/mtgjson";

const nonbasic = Array.from({ length: 80 }, (_, i) => `Test Card ${String(i + 1).padStart(2, "0")}`);

function card(name: string, number: string, extra: Partial<MtgjsonCard> = {}): MtgjsonCard {
  const id = `00000000-0000-4000-8000-${number.padStart(12, "0")}`;
  return {
    name,
    count: 1,
    isFoil: false,
    setCode: "TST",
    number,
    identifiers: { scryfallId: id, scryfallOracleId: `11111111-0000-4000-8000-${number.padStart(12, "0")}` },
    foreignData: [{ language: "Japanese", name: `テストカード${number}` }],
    types: ["Creature"],
    ...extra,
  };
}

export function sampleMtgjsonDeck(): MtgjsonDeck {
  return {
    name: "World Tester",
    code: "TST",
    type: "Commander Deck",
    releaseDate: "2026-08-01",
    commander: [card("Tester, the Worldseed", "1", { isFoil: true, foreignData: [{ language: "Japanese", name: "世界種、テスター" }] })],
    mainBoard: [
      card("Sol Ring", "57"),
      card("Arcane Signet", "58"),
      ...nonbasic.slice(0, 78).map((n, i) => card(n, String(100 + i))),
      card("Forest", "300", { count: 10, supertypes: ["Basic"], types: ["Land"] }),
      card("Swamp", "301", { count: 9, supertypes: ["Basic"], types: ["Land"] }),
    ],
    tokens: [card("Beast Token", "T1", { types: ["Token"] })],
    displayCommander: [card("Tester, the Worldseed", "1", { isFoil: true })],
  };
}

export function sampleWizardsHtml(opts: { swap?: boolean } = {}) {
  const d = sampleMtgjsonDeck();
  const main = d.mainBoard!.map((c) => `${c.count} ${c.name}`);
  if (opts.swap) main[1] = "1 Mind Stone"; // 公式ページ側の変更を模擬
  return `<html><body><article>
  <h2>World Tester</h2>
  <deck-list deck-title="World Tester" format="commander" mode="article">
    <main-deck>
${main.join("\n")}
    </main-deck>
    <side-board>
1 Tester, the Worldseed
    </side-board>
  </deck-list>
  <deck-list deck-title="Other &amp; Deck" format="commander"><main-deck>
1 Sol Ring
  </main-deck></deck-list>
</article></body></html>`;
}

export const sampleDeckListJson = {
  meta: {},
  data: [
    { code: "TST", fileName: "WorldTester_TST", name: "World Tester", releaseDate: "2026-08-01", type: "Commander Deck" },
    { code: "TS2", fileName: "Other_TS2", name: "Other Deck", releaseDate: "2025-01-01", type: "Challenger Deck" },
  ],
};

/** 晴れる屋の買取検索結果ページ（形式のみ模したもの） */
export function sampleHareruyaHtml() {
  return `<ul>
<li class="itemList itemList--purchase"><a href="/ja/purchase/product/123456/"><div class="itemName">【JP】《ソル・リング/Sol Ring》[TST] No.57</div></a>
  <div class="itemDetail"><p class="itemDetail__price">¥1,200</p></div></li>
<li class="itemList"><a href="/ja/purchase/product/123457/"><div class="itemName">【JP】【Foil】《ソル・リング/Sol Ring》[TST] No.57</div></a>
  <div class="itemDetail"><p class="itemDetail__price">¥3,000</p></div></li>
<li class="itemList"><a href="/ja/purchase/product/123458/"><div class="itemName">【JP】《ソル・リング/Sol Ring》[TST] No.400</div></a>
  <div class="itemDetail"><p class="itemDetail__price">¥8,000</p></div></li>
<li class="itemList"><a href="/ja/purchase/product/123459/"><div class="itemName">【EN】《Sol Ring》[CMM]</div></a>
  <div class="itemDetail"><p class="itemDetail__price">¥500</p></div></li>
</ul>`;
}
