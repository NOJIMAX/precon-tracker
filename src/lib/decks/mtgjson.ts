import { fetchWithRetry } from "../http";
import { isBasicLandName, nameKey, type Finish, type ParsedDeck, type ParsedLine, type Section } from "./types";

/**
 * MTGJSON（https://mtgjson.com/api/v5/）からデッキ一覧・デッキ内容を取得します。
 * 公式ページを一次情報とし、MTGJSON はセット記号・コレクター番号・Foil 仕様の補完と検証に使います。
 */
export const MTGJSON_BASE = process.env.MTGJSON_BASE_URL ?? "https://mtgjson.com/api/v5";

export interface DeckListEntry {
  code: string;
  fileName: string;
  name: string;
  releaseDate: string | null;
  type: string;
}

export interface MtgjsonCard {
  name: string;
  count: number;
  isFoil?: boolean;
  finishes?: string[];
  setCode: string;
  number: string;
  uuid?: string;
  identifiers?: { scryfallId?: string; scryfallOracleId?: string };
  foreignData?: { language: string; name: string }[];
  supertypes?: string[];
  types?: string[];
  borderColor?: string;
  frameEffects?: string[];
  isFullArt?: boolean;
  promoTypes?: string[];
}

export interface MtgjsonDeck {
  name: string;
  code: string;
  type: string;
  releaseDate?: string | null;
  commander?: MtgjsonCard[];
  mainBoard?: MtgjsonCard[];
  sideBoard?: MtgjsonCard[];
  tokens?: MtgjsonCard[];
  displayCommander?: MtgjsonCard[];
  planes?: MtgjsonCard[];
  schemes?: MtgjsonCard[];
}

/** 製品カテゴリと MTGJSON のデッキ種別の対応（将来の拡張用） */
export const CATEGORY_TYPES: Record<string, string[]> = {
  commander: ["Commander Deck"],
  challenger: ["Challenger Deck"],
  starter: ["Starter Kit", "Starter Deck"],
};

export function categoryOfType(type: string): "commander" | "challenger" | "starter" | "other" {
  for (const [cat, types] of Object.entries(CATEGORY_TYPES)) if (types.includes(type)) return cat as never;
  return "other";
}

export async function fetchDeckList(): Promise<DeckListEntry[]> {
  const res = await fetchWithRetry(`${MTGJSON_BASE}/DeckList.json`, { timeoutMs: 60_000 });
  const json = (await res.json()) as { data: DeckListEntry[] };
  return json.data;
}

export async function fetchMtgjsonDeck(fileName: string): Promise<MtgjsonDeck> {
  if (!/^[\w.-]+$/.test(fileName)) throw new Error(`不正なデッキファイル名: ${fileName}`);
  const res = await fetchWithRetry(`${MTGJSON_BASE}/decks/${encodeURIComponent(fileName)}.json`, { timeoutMs: 30_000 });
  const json = (await res.json()) as { data: MtgjsonDeck };
  return json.data;
}

export function cardFinish(c: MtgjsonCard): Finish | null {
  if (c.isFoil === true) {
    if (c.finishes?.includes("etched") && !c.finishes.includes("foil")) return "etched";
    return "foil";
  }
  if (c.isFoil === false) return "nonfoil";
  // isFoil が無い古いデータ: 仕様が1種類しかないときだけ確定
  if (c.finishes?.length === 1) return c.finishes[0] as Finish;
  return null;
}

export function cardVariant(c: MtgjsonCard): string | null {
  const v: string[] = [];
  if (c.borderColor === "borderless") v.push("borderless");
  for (const f of c.frameEffects ?? []) if (["showcase", "extendedart", "etched", "inverted"].includes(f)) v.push(f);
  if (c.isFullArt) v.push("fullart");
  return v.length ? v.join(",") : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v?: string) => (v && UUID_RE.test(v) ? v : null);

function toLine(c: MtgjsonCard, section: Section, lineNo: number): ParsedLine {
  const finish = cardFinish(c);
  const ja = c.foreignData?.find((f) => f.language === "Japanese")?.name ?? null;
  const missing: string[] = [];
  if (!c.setCode) missing.push("セット");
  if (!c.number) missing.push("番号");
  if (!finish) missing.push("Foil仕様");
  return {
    lineNo,
    name: c.name,
    quantity: c.count,
    section,
    nameJa: ja,
    oracleId: uuidOrNull(c.identifiers?.scryfallOracleId),
    scryfallId: uuidOrNull(c.identifiers?.scryfallId),
    setCode: c.setCode?.toUpperCase() ?? null,
    collectorNumber: c.number ?? null,
    finish,
    variant: cardVariant(c),
    isBasicLand: (c.supertypes ?? []).includes("Basic") || isBasicLandName(c.name),
    needsReview: missing.length > 0,
    note: missing.length ? `${missing.join("・")}が不明` : null,
  };
}

export function mtgjsonDeckToParsed(d: MtgjsonDeck, fileName: string): ParsedDeck {
  const lines: ParsedLine[] = [];
  let n = 0;
  for (const c of d.commander ?? []) lines.push(toLine(c, "commander", ++n));
  for (const c of d.mainBoard ?? []) lines.push(toLine(c, "main", ++n));
  for (const c of d.sideBoard ?? []) lines.push(toLine(c, "other", ++n));
  for (const c of d.displayCommander ?? []) lines.push(toLine(c, "display", ++n));
  for (const c of d.tokens ?? []) lines.push(toLine(c, "token", ++n));
  const category = categoryOfType(d.type);
  return {
    name: d.name,
    source: "mtgjson",
    sourceKey: `mtgjson:${fileName}`,
    mtgjsonFile: fileName,
    setCode: d.code?.toUpperCase() ?? null,
    releaseDate: d.releaseDate ?? null,
    category,
    expectedCardCount: category === "commander" ? 100 : 60,
    commanderNames: (d.commander ?? []).map((c) => c.name),
    lines,
    warnings: [],
  };
}

/**
 * 公式ページのデッキ（名前と枚数のみ）に MTGJSON の印刷情報を重ねます。
 * - 名前と枚数が一致したカードだけ印刷仕様を確定
 * - 公式と MTGJSON で食い違うカードは確認待ちのまま残し、警告を出す
 * 公式ページの内容を正とし、MTGJSON にしか無いカードは追加しません（警告のみ）。
 */
export function mergeOfficialWithMtgjson(official: ParsedDeck, mj: ParsedDeck): ParsedDeck {
  const pool = new Map<string, ParsedLine[]>();
  for (const l of mj.lines.filter((l) => l.section === "commander" || l.section === "main")) {
    const k = nameKey(l.name);
    pool.set(k, [...(pool.get(k) ?? []), l]);
  }
  const warnings = [...official.warnings];
  const used = new Set<string>();
  const lines = official.lines.map((ol) => {
    const k = nameKey(ol.name);
    const cands = pool.get(k) ?? [];
    used.add(k);
    const total = cands.reduce((s, c) => s + c.quantity, 0);
    if (!cands.length) {
      warnings.push(`MTGJSONに無いカード: ${ol.name}`);
      return { ...ol, note: "MTGJSONで印刷仕様を確認できません" };
    }
    if (total !== ol.quantity) {
      warnings.push(`枚数不一致: ${ol.name}（公式 ${ol.quantity} / MTGJSON ${total}）`);
      return { ...ol, note: `MTGJSONと枚数が不一致（${total}枚）` };
    }
    if (cands.length > 1) {
      // 同名で複数の印刷版（例: 基本土地の絵違い）。公式ページだけでは割り当てられないので分割して保持
      return cands.map((c) => ({ ...c, lineNo: ol.lineNo, section: ol.section === "commander" ? "commander" : c.section }));
    }
    const c = cands[0];
    const commanderMismatch = ol.section === "commander" && c.section !== "commander";
    if (commanderMismatch) warnings.push(`統率者区分が不一致: ${ol.name}`);
    return {
      ...c,
      lineNo: ol.lineNo,
      name: ol.name,
      section: ol.section,
      needsReview: c.needsReview || commanderMismatch,
      note: commanderMismatch ? "統率者区分が MTGJSON と不一致" : c.note,
    };
  });
  for (const [k, ls] of pool) if (!used.has(k)) warnings.push(`公式ページに無いカード（MTGJSONのみ）: ${ls[0].name}`);
  const flat = lines.flat().map((l, i) => ({ ...l, lineNo: i + 1 }));
  // 公式に無いトークン等は MTGJSON から（合計に含めない区分として）引き継ぐ
  for (const l of mj.lines.filter((l) => l.section === "token" || l.section === "display")) {
    flat.push({ ...l, lineNo: flat.length + 1 });
  }
  return {
    ...official,
    mtgjsonFile: mj.mtgjsonFile,
    setCode: official.setCode ?? mj.setCode,
    releaseDate: official.releaseDate ?? mj.releaseDate,
    commanderNames: flat.filter((l) => l.section === "commander").map((l) => l.name),
    lines: flat,
    warnings,
  };
}
