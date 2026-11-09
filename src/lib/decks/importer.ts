import { sql } from "../db";
import { fetchWithRetry } from "../http";
import { categoryOfType, fetchDeckList, fetchMtgjsonDeck, mergeOfficialWithMtgjson, mtgjsonDeckToParsed } from "./mtgjson";
import { recordDeckCheck, saveDeck } from "./store";
import { nameKey, type Language, type ParsedDeck } from "./types";
import { isOfficialUrl, parseWizardsDecklists } from "./wizards";

/** MTGJSON の DeckList.json を検索用カタログとして保存 */
export async function refreshCatalog() {
  const list = await fetchDeckList();
  const db = sql();
  const rows = list.map((d) => ({
    file_name: d.fileName,
    name: d.name,
    set_code: d.code.toUpperCase(),
    deck_type: d.type,
    release_date: d.releaseDate || null,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db`insert into deck_catalog ${db(chunk, "file_name", "name", "set_code", "deck_type", "release_date")}
      on conflict (file_name) do update set name = excluded.name, set_code = excluded.set_code,
        deck_type = excluded.deck_type, release_date = excluded.release_date, fetched_at = now()`;
  }
  return rows.length;
}

/** 公式デッキ名に一致するカタログ項目（同名が複数ある場合はセット記号で絞り込み、なお複数なら null） */
async function findCatalogFor(name: string, setCode?: string | null) {
  const rows = await sql()<{ file_name: string; set_code: string; deck_type: string }[]>`
    select file_name, set_code, deck_type from deck_catalog where lower(name) = lower(${name})`;
  const narrowed = setCode ? rows.filter((r) => r.set_code === setCode.toUpperCase()) : rows;
  return narrowed.length === 1 ? narrowed[0] : null;
}

export async function fetchOfficialDecks(url: string): Promise<ParsedDeck[]> {
  if (!isOfficialUrl(url)) throw new Error("公式サイト（magic.wizards.com / mtg-jp.com）のURLを指定してください");
  const res = await fetchWithRetry(url, { timeoutMs: 30_000 });
  const html = await res.text();
  const decks = parseWizardsDecklists(html, url);
  if (!decks.length) {
    throw new Error(
      "ページからデッキリスト（<deck-list> 要素）を見つけられませんでした。ページ構成が想定と異なる可能性があります。MTGJSON からの登録かCSV登録をご利用ください",
    );
  }
  return decks;
}

/** 公式ページのデッキに MTGJSON の印刷情報を重ねる（一致するカタログが無ければ未確定のまま） */
export async function enrichOfficialDeck(d: ParsedDeck, setCode?: string | null): Promise<ParsedDeck> {
  const cat = await findCatalogFor(d.name, setCode);
  if (!cat) {
    return { ...d, setCode: setCode ?? d.setCode, warnings: [...d.warnings, "MTGJSONに同名のデッキが一意に見つからないため、印刷仕様は確認待ちです"] };
  }
  const mj = mtgjsonDeckToParsed(await fetchMtgjsonDeck(cat.file_name), cat.file_name);
  const merged = mergeOfficialWithMtgjson(d, mj);
  return { ...merged, category: categoryOfType(cat.deck_type) };
}

export async function previewOfficialUrl(url: string, setCode?: string | null) {
  const decks = await fetchOfficialDecks(url);
  return Promise.all(decks.map((d) => enrichOfficialDeck(d, setCode)));
}

export async function importOfficialUrl(url: string, language: Language, opts: { setCode?: string | null; only?: string[] } = {}) {
  const decks = await previewOfficialUrl(url, opts.setCode);
  const results: { name: string; deckId?: string; error?: string; ok?: boolean }[] = [];
  for (const d of decks) {
    if (opts.only && !opts.only.some((n) => nameKey(n) === nameKey(d.name))) continue;
    try {
      const r = await saveDeck(d, language);
      results.push({ name: d.name, deckId: r.deckId, ok: r.validation.ok });
    } catch (e) {
      results.push({ name: d.name, error: (e as Error).message, deckId: (e as { deckId?: string }).deckId });
    }
  }
  return results;
}

export async function importMtgjsonDeck(fileName: string, language: Language) {
  const [cat] = await sql()<{ deck_type: string }[]>`select deck_type from deck_catalog where file_name = ${fileName}`;
  const parsed = mtgjsonDeckToParsed(await fetchMtgjsonDeck(fileName), fileName);
  if (cat) parsed.category = categoryOfType(cat.deck_type);
  parsed.warnings.push("公式ページではなく MTGJSON から登録しました（公式URLを設定すると差分検知の対象になります）");
  return saveDeck(parsed, language);
}

/** 公式URLを持つデッキを再取得し、内容の変更を検知する */
export async function checkDeckForChanges(deckId: string) {
  const [d] = await sql()<{ official_url: string | null; name: string; set_code: string | null; mtgjson_file: string | null }[]>`
    select official_url, name, set_code, mtgjson_file from decks where id = ${deckId}`;
  if (!d) throw new Error("デッキが見つかりません");
  let fresh: ParsedDeck | undefined;
  if (d.official_url) {
    const decks = await fetchOfficialDecks(d.official_url);
    fresh = decks.find((x) => nameKey(x.name) === nameKey(d.name));
    if (!fresh) throw new Error(`公式ページに「${d.name}」が見つかりません`);
  } else if (d.mtgjson_file) {
    fresh = mtgjsonDeckToParsed(await fetchMtgjsonDeck(d.mtgjson_file), d.mtgjson_file);
  } else {
    return { changed: false, skipped: true as const };
  }
  return recordDeckCheck(deckId, fresh);
}
