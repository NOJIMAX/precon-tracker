import { sql } from "../db";
import { COUNTED_SECTIONS, scryfallImageUrl, type Language, type ParsedDeck, type ParsedLine } from "./types";
import { contentHash, diffLines, isEmptyDiff, validateDeck, type DeckValidation } from "./validate";

type Tx = import("postgres").TransactionSql<Record<string, unknown>>;

export class DuplicateDeckError extends Error {
  constructor(public deckId: string) {
    super("このデッキは登録済みです");
  }
}

export async function findExistingDeck(d: Pick<ParsedDeck, "sourceKey" | "mtgjsonFile">, language: Language) {
  const rows = await sql()<{ id: string }[]>`
    select id from decks
     where language = ${language}
       and (source_key = ${d.sourceKey} or (${d.mtgjsonFile ?? null}::text is not null and mtgjson_file = ${d.mtgjsonFile ?? null}))
     limit 1`;
  return rows[0]?.id ?? null;
}

async function upsertProduct(tx: Tx, d: ParsedDeck) {
  const name = d.productName ?? (d.setCode ? `${d.setCode} 構築済みデッキ` : d.name);
  const [p] = await tx<{ id: string }[]>`
    insert into products (name, category, set_code, set_name, release_date, official_url)
    values (${name}, ${d.category ?? "commander"}, ${d.setCode ?? null}, ${d.setName ?? null}, ${d.releaseDate ?? null}, ${d.officialUrl ?? null})
    on conflict (name, set_code) do update set release_date = coalesce(products.release_date, excluded.release_date)
    returning id`;
  return p?.id ?? null;
}

async function upsertCard(tx: Tx, l: ParsedLine): Promise<string> {
  if (l.oracleId) {
    const [c] = await tx<{ id: string }[]>`
      insert into cards (oracle_id, name_en, name_ja) values (${l.oracleId}, ${l.name}, ${l.nameJa ?? null})
      on conflict (oracle_id) do update set name_ja = coalesce(cards.name_ja, excluded.name_ja)
      returning id`;
    return c.id;
  }
  const found = await tx<{ id: string }[]>`select id from cards where oracle_id is null and lower(name_en) = lower(${l.name}) limit 1`;
  if (found[0]) return found[0].id;
  const [c] = await tx<{ id: string }[]>`insert into cards (name_en, name_ja) values (${l.name}, ${l.nameJa ?? null}) returning id`;
  return c.id;
}

/** セット・番号・言語・仕様がすべて揃っている行だけ印刷版を作る（推測で補完しない） */
async function upsertPrinting(tx: Tx, l: ParsedLine, language: Language): Promise<string | null> {
  if (!l.setCode || !l.collectorNumber || !l.finish) return null;
  const cardId = await upsertCard(tx, l);
  const [p] = await tx<{ id: string }[]>`
    insert into card_printings (card_id, scryfall_id, set_code, collector_number, language, finish, variant, image_url)
    values (${cardId}, ${l.scryfallId ?? null}, ${l.setCode}, ${l.collectorNumber}, ${language}, ${l.finish},
            ${l.variant ?? null}, ${scryfallImageUrl(l.scryfallId)})
    on conflict (set_code, collector_number, language, finish) do update
      set scryfall_id = coalesce(card_printings.scryfall_id, excluded.scryfall_id),
          image_url   = coalesce(card_printings.image_url, excluded.image_url),
          variant     = coalesce(card_printings.variant, excluded.variant)
    returning id`;
  return p.id;
}

async function writeLines(tx: Tx, deckId: string, d: ParsedDeck, language: Language) {
  await tx`delete from deck_cards where deck_id = ${deckId}`;
  for (const l of d.lines) {
    const printingId = await upsertPrinting(tx, l, language);
    const resolved = !!printingId && !l.needsReview;
    await tx`
      insert into deck_cards (deck_id, line_no, card_name, printing_id, quantity, section, is_basic_land, resolution_status, note)
      values (${deckId}, ${l.lineNo}, ${l.name}, ${printingId}, ${l.quantity}, ${l.section}, ${l.isBasicLand},
              ${resolved ? "resolved" : "needs_review"}, ${l.note ?? null})`;
  }
}

export interface SaveResult {
  deckId: string;
  validation: DeckValidation;
}

export async function saveDeck(d: ParsedDeck, language: Language): Promise<SaveResult> {
  const existing = await findExistingDeck(d, language);
  if (existing) throw new DuplicateDeckError(existing);
  const validation = validateDeck(d);
  const hash = contentHash(d.lines);
  const commander = d.lines.find((l) => l.section === "commander" && l.scryfallId);
  const deckId = await sql().begin(async (tx) => {
    const productId = await upsertProduct(tx, d);
    const [deck] = await tx<{ id: string }[]>`
      insert into decks (product_id, name, name_ja, language, source, source_key, official_url, mtgjson_file, set_code,
                         release_date, expected_card_count, commander_names, image_url, status, validation, content_hash, last_checked_at)
      values (${productId}, ${d.name}, ${d.nameJa ?? null}, ${language}, ${d.source}, ${d.sourceKey}, ${d.officialUrl ?? null},
              ${d.mtgjsonFile ?? null}, ${d.setCode ?? null}, ${d.releaseDate ?? null}, ${d.expectedCardCount},
              ${d.commanderNames}, ${scryfallImageUrl(commander?.scryfallId)}, ${validation.ok ? "ok" : "needs_review"},
              ${tx.json(validation as never)}, ${hash}, now())
      returning id`;
    await writeLines(tx, deck.id, d, language);
    await tx`insert into deck_revisions (deck_id, content_hash, changed) values (${deck.id}, ${hash}, false)`;
    return deck.id;
  });
  return { deckId, validation };
}

/**
 * 公式ページ等を再取得した結果と保存済みデッキを比べます。
 * 変更があっても自動では上書きせず、差分を記録して「確認待ち」にします。
 */
export async function recordDeckCheck(deckId: string, fresh: ParsedDeck) {
  const db = sql();
  const current = await db<{ section: string; card_name: string; quantity: number }[]>`
    select section, card_name, quantity from deck_cards where deck_id = ${deckId}`;
  const before = current.map((r) => ({ section: r.section as ParsedLine["section"], name: r.card_name, quantity: r.quantity }));
  const hash = contentHash(fresh.lines);
  const diff = diffLines(
    before.filter((l) => COUNTED_SECTIONS.includes(l.section)),
    fresh.lines.filter((l) => COUNTED_SECTIONS.includes(l.section)),
  );
  const changed = !isEmptyDiff(diff);
  await db`insert into deck_revisions (deck_id, content_hash, changed, diff) values (${deckId}, ${hash}, ${changed}, ${db.json(diff as never)})`;
  if (changed) {
    await db`update decks set last_checked_at = now(), diff_detected_at = now(), status = 'needs_review' where id = ${deckId}`;
  } else {
    await db`update decks set last_checked_at = now() where id = ${deckId}`;
  }
  return { changed, diff };
}

/** 確認待ちのカード行に印刷仕様を手動で設定する */
export async function resolveDeckCard(
  deckCardId: string,
  p: { setCode: string; collectorNumber: string; finish: "nonfoil" | "foil" | "etched"; scryfallId?: string | null; oracleId?: string | null; nameJa?: string | null },
) {
  return sql().begin(async (tx) => {
    const [dc] = await tx<{ deck_id: string; card_name: string; language: Language; line_no: number; quantity: number; section: string; is_basic_land: boolean }[]>`
      select dc.deck_id, dc.card_name, d.language, dc.line_no, dc.quantity, dc.section, dc.is_basic_land
        from deck_cards dc join decks d on d.id = dc.deck_id where dc.id = ${deckCardId}`;
    if (!dc) throw new Error("カード行が見つかりません");
    const printingId = await upsertPrinting(
      tx,
      {
        lineNo: dc.line_no, name: dc.card_name, quantity: dc.quantity, section: dc.section as never, isBasicLand: dc.is_basic_land,
        setCode: p.setCode.toUpperCase(), collectorNumber: p.collectorNumber, finish: p.finish,
        scryfallId: p.scryfallId ?? null, oracleId: p.oracleId ?? null, nameJa: p.nameJa ?? null, needsReview: false,
      },
      dc.language,
    );
    await tx`update deck_cards set printing_id = ${printingId}, resolution_status = 'resolved', note = '手動で確定' where id = ${deckCardId}`;
    await refreshDeckStatus(tx, dc.deck_id);
    return printingId;
  });
}

export async function refreshDeckStatus(tx: Tx, deckId: string) {
  const [r] = await tx<{ unresolved: number; total: number; expected: number; diff: boolean }[]>`
    select count(*) filter (where dc.resolution_status = 'needs_review' and dc.section in ('commander','main'))::int as unresolved,
           coalesce(sum(dc.quantity) filter (where dc.section in ('commander','main')), 0)::int as total,
           d.expected_card_count as expected,
           (d.diff_detected_at is not null) as diff
      from decks d left join deck_cards dc on dc.deck_id = d.id
     where d.id = ${deckId} group by d.id`;
  const ok = r && r.unresolved === 0 && r.total === r.expected && !r.diff;
  await tx`update decks set status = ${ok ? "ok" : "needs_review"},
             validation = validation || ${tx.json({ countedTotal: r?.total, unresolvedLines: r?.unresolved, countOk: r?.total === r?.expected } as never)}
           where id = ${deckId}`;
}
