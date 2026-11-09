export type Language = "ja" | "en";
export type Finish = "nonfoil" | "foil" | "etched";
export type Section = "commander" | "main" | "token" | "display" | "other";

/** 合計枚数に数える区分 */
export const COUNTED_SECTIONS: Section[] = ["commander", "main"];

export interface ParsedLine {
  lineNo: number;
  name: string;
  quantity: number;
  section: Section;
  nameJa?: string | null;
  oracleId?: string | null;
  scryfallId?: string | null;
  setCode?: string | null;
  collectorNumber?: string | null;
  finish?: Finish | null;
  variant?: string | null;
  isBasicLand: boolean;
  /** true のとき印刷仕様が確定していない（確認待ち） */
  needsReview: boolean;
  note?: string | null;
}

export interface ParsedDeck {
  name: string;
  nameJa?: string | null;
  source: "wizards" | "mtgjson" | "csv";
  sourceKey: string;
  officialUrl?: string | null;
  mtgjsonFile?: string | null;
  setCode?: string | null;
  setName?: string | null;
  releaseDate?: string | null;
  productName?: string | null;
  category?: "commander" | "challenger" | "starter" | "other";
  expectedCardCount: number;
  commanderNames: string[];
  lines: ParsedLine[];
  warnings: string[];
}

const BASIC_LANDS = new Set([
  "Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
  "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest",
  "Snow-Covered Wastes",
]);

export function isBasicLandName(name: string): boolean {
  return BASIC_LANDS.has(name.trim());
}

/** 全角・記号ゆれを吸収した照合用キー（照合の補助にのみ使い、自動採用の根拠にはしない） */
export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s*\/\/\s*/g, " // ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scryfallImageUrl(scryfallId: string | null | undefined, size: "small" | "normal" = "normal") {
  if (!scryfallId) return null;
  return `https://cards.scryfall.io/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}
