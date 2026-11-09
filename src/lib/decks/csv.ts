import Papa from "papaparse";
import { isBasicLandName, type Finish, type ParsedDeck, type ParsedLine, type Section } from "./types";

/**
 * 手動登録用のデッキCSV。1行目は見出し行で、列名は日本語・英語どちらでも受け付けます。
 *
 *   枚数,カード名,セット,番号,仕様,区分,日本語名
 *   1,Hearthhull, the Worldseed,EOC,1,foil,commander,
 *   1,Sol Ring,EOC,57,nonfoil,main,
 *
 * 必須: 枚数・カード名。セット・番号・仕様が無い行は「確認待ち」になります（推測で補完しません）。
 */
const COLS: Record<string, string[]> = {
  quantity: ["quantity", "qty", "count", "枚数"],
  name: ["name", "card_name", "カード名", "英語名"],
  set: ["set", "set_code", "セット", "セット記号"],
  number: ["number", "collector_number", "番号", "コレクター番号"],
  finish: ["finish", "foil", "仕様"],
  section: ["section", "区分"],
  nameJa: ["name_ja", "日本語名"],
};

const SECTION_MAP: Record<string, Section> = {
  commander: "commander", 統率者: "commander",
  main: "main", メイン: "main", "": "main",
  token: "token", トークン: "token",
  display: "display", ディスプレイ: "display",
  other: "other", その他: "other",
};

export function parseFinish(v: string | undefined | null): Finish | null {
  const s = (v ?? "").trim().toLowerCase();
  if (["nonfoil", "non-foil", "normal", "通常", "n", "false", "0"].includes(s)) return "nonfoil";
  if (["foil", "f", "true", "1", "フォイル"].includes(s)) return "foil";
  if (["etched", "エッチング", "エッチングfoil"].includes(s)) return "etched";
  return null;
}

export interface CsvDeckMeta {
  name: string;
  setCode?: string | null;
  expectedCardCount?: number;
  category?: ParsedDeck["category"];
}

export function parseDeckCsv(text: string, meta: CsvDeckMeta): ParsedDeck {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase(),
  });
  const pick = (row: Record<string, string>, key: keyof typeof COLS) => {
    for (const c of COLS[key]) if (row[c] !== undefined) return row[c]?.trim();
    return undefined;
  };
  const warnings: string[] = parsed.errors.map((e) => `CSV ${e.row !== undefined ? e.row + 2 + "行目" : ""}: ${e.message}`);
  const lines: ParsedLine[] = [];
  parsed.data.forEach((row, i) => {
    const name = pick(row, "name");
    const qty = Number(pick(row, "quantity"));
    if (!name || !Number.isInteger(qty) || qty <= 0) {
      warnings.push(`${i + 2}行目: 枚数またはカード名が不正のため読み飛ばしました`);
      return;
    }
    const secRaw = (pick(row, "section") ?? "").toLowerCase();
    const section = SECTION_MAP[secRaw];
    if (!section) warnings.push(`${i + 2}行目: 区分「${secRaw}」が不明のため main として扱います`);
    const setCode = pick(row, "set")?.toUpperCase() || null;
    const number = pick(row, "number") || null;
    const finish = parseFinish(pick(row, "finish"));
    const missing = [!setCode && "セット", !number && "番号", !finish && "Foil仕様"].filter(Boolean);
    lines.push({
      lineNo: lines.length + 1,
      name,
      quantity: qty,
      section: section ?? "main",
      nameJa: pick(row, "nameJa") || null,
      setCode,
      collectorNumber: number,
      finish,
      isBasicLand: isBasicLandName(name),
      needsReview: missing.length > 0,
      note: missing.length ? `${missing.join("・")}が未入力` : null,
    });
  });
  return {
    name: meta.name,
    source: "csv",
    sourceKey: `csv:${meta.name}`,
    setCode: meta.setCode ?? null,
    category: meta.category ?? "commander",
    expectedCardCount: meta.expectedCardCount ?? 100,
    commanderNames: lines.filter((l) => l.section === "commander").map((l) => l.name),
    lines,
    warnings,
  };
}
