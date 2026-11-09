import { decodeEntities } from "../decks/wizards";
import type { Finish, Language } from "../decks/types";
import { fetchWithRetry, HttpError, sleep, type FetchOpts } from "../http";
import type { Candidate } from "./match";
import { matchCandidates } from "./match";
import type { LookupResult, PriceAdapter, PrintingForLookup } from "./types";

/**
 * 晴れる屋 買取ページの読み取り（自動取得アダプター）。
 *
 * ⚠ 既定では無効です。晴れる屋は公開APIを提供しておらず、robots.txt で検索結果のページ送り・並べ替えが
 *   禁止されています。晴れる屋から自動取得の許可を得た場合に限り、
 *   HARERUYA_AUTO_FETCH=enabled と price_sources.fetch_mode='auto' の両方を設定して有効化してください。
 *
 * 有効時の動作:
 *  - 1カードにつき1回だけ検索（カード名＋言語）。ページ送り・並べ替えは使わない
 *  - リクエスト間隔は HARERUYA_MIN_INTERVAL_MS（既定 3000ms）以上
 *  - 1回の実行あたりの上限は HARERUYA_MAX_REQUESTS_PER_RUN（既定 300件）
 *
 * ページ構造（2026年9月時点で確認した内容。変わった場合はここを直します）:
 *  - 1件 = <li class="itemList ...">、カード名は class="itemName" 内の《》、セット記号は []、言語・Foil は 【】
 *  - 価格は class="itemDetail__price"
 */
export const HARERUYA_SEARCH = "https://www.hareruyamtg.com/ja/purchase/search";

export function hareruyaSearchUrl(name: string, language: Language) {
  const u = new URL(HARERUYA_SEARCH);
  u.searchParams.set("product", name);
  u.searchParams.append("language[]", language === "ja" ? "1" : "2");
  return u.toString();
}

export function parseHareruyaPurchaseSearch(html: string, baseUrl = HARERUYA_SEARCH): Candidate[] {
  const out: Candidate[] = [];
  const re = /<li\b[^>]*class="[^"]*\bitemList\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const block = m[1];
    const nameHtml = /class="[^"]*\bitemName\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|p|span)>/i.exec(block)?.[1] ?? "";
    const text = decodeEntities(nameHtml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const nameMatch = /《([^》]+)》/.exec(text);
    if (!nameMatch) continue;
    // 《日本語名/English Name》 の形式なら英語名を使う
    const rawName = nameMatch[1];
    const name = rawName.includes("/") ? rawName.split("/").slice(1).join("/").trim() : rawName.trim();
    const setCode = /\[([A-Z0-9-]{2,10})\]/.exec(text)?.[1] ?? null;
    const tags = [...text.matchAll(/【([^】]+)】/g)].map((x) => x[1].toUpperCase());
    const language: Language | null = tags.some((t) => /JP|日本語/.test(t)) ? "ja" : tags.some((t) => /EN|英語/.test(t)) ? "en" : null;
    const finish: Finish = tags.some((t) => /エッチング|ETCHED/.test(t)) ? "etched" : tags.some((t) => /FOIL/.test(t)) ? "foil" : "nonfoil";
    const number = /(?:No\.|#)\s*([0-9A-Za-z★-]+)/.exec(text)?.[1] ?? null;
    const priceText = /class="[^"]*\bitemDetail__price\b[^"]*"[^>]*>([\s\S]*?)</i.exec(block)?.[1] ?? "";
    const digits = priceText.replace(/[^\d]/g, "");
    const href = /href="([^"]+)"/i.exec(block)?.[1];
    const url = href ? new URL(decodeEntities(href), baseUrl).toString() : null;
    const externalId = url ? /\/(\d+)(?:[/?#]|$)/.exec(new URL(url).pathname)?.[1] ?? null : null;
    out.push({
      name,
      setCode,
      collectorNumber: number,
      language,
      finish,
      priceJpy: digits ? Number(digits) : null,
      url,
      externalId,
    });
  }
  return out;
}

export function hareruyaAutoEnabled() {
  return process.env.HARERUYA_AUTO_FETCH === "enabled";
}

export class HareruyaAutoAdapter implements PriceAdapter {
  readonly sourceId = "hareruya_buyback";
  private last = 0;
  private count = 0;
  constructor(
    private readonly opts: { minIntervalMs?: number; maxRequests?: number; fetch?: FetchOpts } = {},
  ) {}

  get requestCount() {
    return this.count;
  }

  async lookup(p: PrintingForLookup): Promise<LookupResult> {
    const max = this.opts.maxRequests ?? Number(process.env.HARERUYA_MAX_REQUESTS_PER_RUN ?? 300);
    if (this.count >= max) return { status: "access_error", detail: `1回の実行上限（${max}件）に達したため未実行` };
    const interval = this.opts.minIntervalMs ?? Number(process.env.HARERUYA_MIN_INTERVAL_MS ?? 3000);
    const wait = this.last + interval - Date.now();
    if (wait > 0) await (this.opts.fetch?.sleep ?? sleep)(wait);
    this.last = Date.now();
    this.count++;
    let html: string;
    const url = hareruyaSearchUrl(p.name, p.language);
    try {
      const res = await fetchWithRetry(url, { timeoutMs: 20_000, retries: 2, baseDelayMs: 5_000, ...this.opts.fetch });
      html = await res.text();
    } catch (e) {
      const status = e instanceof HttpError ? `HTTP ${e.status}` : (e as Error).message;
      return { status: "access_error", detail: status };
    }
    let cands: Candidate[];
    try {
      cands = parseHareruyaPurchaseSearch(html, url);
    } catch (e) {
      return { status: "parse_error", detail: (e as Error).message };
    }
    if (!cands.length && !/itemList/.test(html) && !/該当|見つかりません|0件/.test(html)) {
      return { status: "parse_error", detail: "検索結果の形式を読み取れませんでした（ページ構成の変更の可能性）" };
    }
    // 照合済みの商品があれば、その商品だけを見る
    if (p.knownExternalId || p.knownUrl) {
      const hit = cands.find((c) => (p.knownExternalId && c.externalId === p.knownExternalId) || (p.knownUrl && c.url === p.knownUrl));
      if (!hit) return { status: "not_found", detail: "照合済みの商品が検索結果にありません" };
      return hit.priceJpy == null
        ? { status: "not_listed", detail: "価格が掲載されていません", candidate: hit }
        : { status: "ok", priceJpy: hit.priceJpy, candidate: hit };
    }
    const m = matchCandidates(p, cands);
    if (m.kind === "none") return { status: "not_found", detail: m.reason };
    if (m.kind === "multiple") return { status: "multiple_candidates", detail: `${m.candidates.length}件の候補`, candidates: m.candidates };
    if (m.candidate.priceJpy == null) return { status: "not_listed", detail: "価格が掲載されていません", candidate: m.candidate, matchStatus: m.matchStatus };
    return { status: "ok", priceJpy: m.candidate.priceJpy, candidate: m.candidate, matchStatus: m.matchStatus };
  }
}
