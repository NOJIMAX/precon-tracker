import { isBasicLandName, type ParsedDeck, type ParsedLine } from "./types";

/**
 * Wizards of the Coast 公式のデッキリスト記事（magic.wizards.com/en/news/...-decklists）を解析します。
 *
 * 記事内のデッキは `<deck-list deck-title="..." format="commander">` 要素で、
 * 子要素 `<main-deck>` / `<side-board>` に「枚数 カード名」が1行ずつ入っています。
 * 公式ページにはセット記号・コレクター番号・Foil仕様が載っていないため、
 * ここで作る行はすべて「印刷仕様未確定（needsReview）」です。MTGJSON 等で補完します。
 *
 * 【実装上の仮定】統率者デッキの `<side-board>` は統率者を表すとみなしますが、
 * 公式ページだけでは確定できないため、MTGJSON の統率者情報で一致を確認できるまで確認待ちにします。
 */
export function parseWizardsDecklists(html: string, url: string): ParsedDeck[] {
  const decks: ParsedDeck[] = [];
  const re = /<deck-list\b([^>]*)>([\s\S]*?)<\/deck-list>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[1]);
    const body = m[2];
    const title = decodeEntities(attrs["deck-title"] ?? "").trim();
    if (!title) continue;
    const format = (attrs["format"] ?? "").toLowerCase();
    const warnings: string[] = [];
    const lines: ParsedLine[] = [];
    let lineNo = 0;
    const sections: [string, ParsedLine["section"]][] = [
      ["main-deck", "main"],
      ["side-board", format === "commander" ? "commander" : "other"],
    ];
    for (const [tag, section] of sections) {
      const sm = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(body);
      if (!sm) continue;
      for (const raw of stripTags(sm[1]).split(/\r?\n/)) {
        const t = decodeEntities(raw).trim();
        if (!t) continue;
        const lm = /^(\d+)\s*x?\s+(.+)$/.exec(t);
        if (!lm) {
          warnings.push(`解析できない行: "${t}"`);
          continue;
        }
        const name = lm[2].trim();
        lines.push({
          lineNo: ++lineNo,
          name,
          quantity: Number(lm[1]),
          section,
          isBasicLand: isBasicLandName(name),
          needsReview: true,
          note: section === "commander" ? "統率者（公式ページの side-board 区分）" : null,
        });
      }
    }
    if (!lines.length) warnings.push("カード行が見つかりませんでした");
    decks.push({
      name: title,
      source: "wizards",
      sourceKey: `wizards:${normalizeUrl(url)}#${title}`,
      officialUrl: url,
      category: format === "commander" ? "commander" : "other",
      expectedCardCount: format === "commander" ? 100 : 60,
      commanderNames: lines.filter((l) => l.section === "commander").map((l) => l.name),
      lines,
      warnings,
    });
  }
  return decks;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

export function isOfficialUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "magic.wizards.com" || h === "mtg-jp.com" || h.endsWith(".mtg-jp.com");
  } catch {
    return false;
  }
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? "";
  return out;
}

function stripTags(s: string) {
  return s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
}

export function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
