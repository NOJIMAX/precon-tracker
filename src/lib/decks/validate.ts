import { createHash } from "node:crypto";
import { COUNTED_SECTIONS, nameKey, type ParsedDeck, type ParsedLine } from "./types";

export interface DeckValidation {
  countedTotal: number;
  expected: number;
  countOk: boolean;
  excludedTotal: number;
  unresolvedLines: number;
  commanderCount: number;
  warnings: string[];
  ok: boolean;
}

export function validateDeck(d: ParsedDeck): DeckValidation {
  const counted = d.lines.filter((l) => COUNTED_SECTIONS.includes(l.section));
  const countedTotal = counted.reduce((s, l) => s + l.quantity, 0);
  const excludedTotal = d.lines.filter((l) => !COUNTED_SECTIONS.includes(l.section)).reduce((s, l) => s + l.quantity, 0);
  const unresolvedLines = counted.filter((l) => l.needsReview).length;
  const commanderCount = counted.filter((l) => l.section === "commander").reduce((s, l) => s + l.quantity, 0);
  const warnings = [...d.warnings];
  const countOk = countedTotal === d.expectedCardCount;
  if (!countOk) warnings.push(`カード枚数が ${countedTotal} 枚です（想定 ${d.expectedCardCount} 枚）`);
  if (d.category === "commander" && commanderCount === 0) warnings.push("統率者が特定できていません");
  if (unresolvedLines) warnings.push(`印刷仕様が未確定のカードが ${unresolvedLines} 行あります`);
  return {
    countedTotal,
    expected: d.expectedCardCount,
    countOk,
    excludedTotal,
    unresolvedLines,
    commanderCount,
    warnings,
    ok: countOk && unresolvedLines === 0 && warnings.length === 0,
  };
}

/** デッキ内容（区分・名前・枚数・印刷仕様）のハッシュ。公式ページの変更検知に使います */
export function contentHash(lines: Pick<ParsedLine, "section" | "name" | "quantity">[]): string {
  const norm = lines
    .map((l) => `${l.section}|${nameKey(l.name)}|${l.quantity}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(norm).digest("hex");
}

export interface DeckDiff {
  added: { name: string; quantity: number; section: string }[];
  removed: { name: string; quantity: number; section: string }[];
  changed: { name: string; section: string; from: number; to: number }[];
}

export function diffLines(
  before: Pick<ParsedLine, "section" | "name" | "quantity">[],
  after: Pick<ParsedLine, "section" | "name" | "quantity">[],
): DeckDiff {
  const agg = (ls: typeof before) => {
    const m = new Map<string, { name: string; section: string; quantity: number }>();
    for (const l of ls) {
      const k = `${l.section}|${nameKey(l.name)}`;
      const cur = m.get(k);
      m.set(k, { name: l.name, section: l.section, quantity: (cur?.quantity ?? 0) + l.quantity });
    }
    return m;
  };
  const a = agg(before), b = agg(after);
  const diff: DeckDiff = { added: [], removed: [], changed: [] };
  for (const [k, v] of b) {
    const o = a.get(k);
    if (!o) diff.added.push(v);
    else if (o.quantity !== v.quantity) diff.changed.push({ name: v.name, section: v.section, from: o.quantity, to: v.quantity });
  }
  for (const [k, v] of a) if (!b.has(k)) diff.removed.push(v);
  return diff;
}

export function isEmptyDiff(d: DeckDiff) {
  return !d.added.length && !d.removed.length && !d.changed.length;
}
