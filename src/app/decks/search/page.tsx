import Link from "next/link";
import { importDeckCsvAction, refreshCatalogAction, registerMtgjsonAction, registerOfficialAction } from "@/app/actions";
import { Flash } from "@/components/flash";
import { Submit } from "@/components/submit";
import { Badge, Card, Empty, input, Notice, Td, Th } from "@/components/ui";
import { sql } from "@/lib/db";
import { previewOfficialUrl } from "@/lib/decks/importer";
import { validateDeck } from "@/lib/decks/validate";
import type { ParsedDeck } from "@/lib/decks/types";
import { CATEGORY_TYPES } from "@/lib/decks/mtgjson";
import { formatJst } from "@/lib/time";

export const dynamic = "force-dynamic";

type SP = { q?: string; set?: string; year?: string; category?: string; url?: string; msg?: string; err?: string };

const CATEGORY_LABEL: Record<string, string> = { commander: "統率者デッキ", challenger: "チャレンジャーデッキ", starter: "スターターキット", other: "その他" };

async function OfficialPreview({ url, set }: { url: string; set?: string }) {
  let decks: ParsedDeck[];
  try {
    decks = await previewOfficialUrl(url, set || null);
  } catch (e) {
    return <Notice tone="red">取得できませんでした: {(e as Error).message}</Notice>;
  }
  const registered = new Set(
    (await sql()<{ name: string; language: string }[]>`select name, language from decks where official_url = ${url}`).map((r) => `${r.name}|${r.language}`),
  );
  return (
    <form action={registerOfficialAction} className="space-y-3">
      <input type="hidden" name="url" value={url} />
      <input type="hidden" name="set_code" value={set ?? ""} />
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr><Th>{""}</Th><Th>デッキ名</Th><Th>統率者</Th><Th className="text-right">枚数</Th><Th>印刷仕様</Th><Th>確認事項</Th></tr>
          </thead>
          <tbody>
            {decks.map((d) => {
              const v = validateDeck(d);
              const reg = ["ja", "en"].filter((l) => registered.has(`${d.name}|${l}`));
              return (
                <tr key={d.name} className="align-top">
                  <Td><input type="checkbox" name="deck" value={d.name} defaultChecked={!reg.length} /></Td>
                  <Td>
                    <div className="font-medium">{d.name}</div>
                    {reg.map((l) => <Badge key={l} tone="blue">登録済み（{l === "ja" ? "日本語" : "英語"}）</Badge>)}
                  </Td>
                  <Td className="text-gray-600">{d.commanderNames.join(" / ") || "—"}</Td>
                  <Td className={`text-right tabular-nums ${v.countOk ? "" : "text-red-700"}`}>{v.countedTotal} / {v.expected}</Td>
                  <Td>{v.unresolvedLines ? <Badge tone="amber">未確定 {v.unresolvedLines}行</Badge> : <Badge tone="green">確定</Badge>}</Td>
                  <Td className="max-w-md text-xs text-gray-600">
                    {v.warnings.length ? (
                      <ul className="list-disc pl-4">{v.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}{v.warnings.length > 6 && <li>ほか{v.warnings.length - 6}件</li>}</ul>
                    ) : "問題なし"}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select name="language" className={input} defaultValue="ja">
          <option value="ja">日本語版として登録</option>
          <option value="en">英語版として登録</option>
        </select>
        <Submit primary pendingText="登録中…">選んだデッキを登録</Submit>
        <span className="text-xs text-gray-500">確認事項があるデッキも登録できます（確認待ちとして保存され、管理画面で修正できます）</span>
      </div>
    </form>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const db = sql();
  const q = sp.q?.trim() ?? "";
  const category = sp.category ?? "commander";
  const types = category === "all" ? null : category === "other" ? null : CATEGORY_TYPES[category] ?? null;
  const knownTypes = Object.values(CATEGORY_TYPES).flat();
  const [{ n: catalogCount, at }] = await db<{ n: number; at: Date | null }[]>`select count(*)::int as n, max(fetched_at) as at from deck_catalog`;
  const rows = await db<{ file_name: string; name: string; set_code: string; deck_type: string; release_date: string | null; reg: string[] | null }[]>`
    select c.file_name, c.name, c.set_code, c.deck_type, c.release_date::text,
           (select array_agg(d.language) from decks d where d.mtgjson_file = c.file_name) as reg
      from deck_catalog c
     where true
       ${q ? db`and (c.name ilike ${"%" + q + "%"} or c.set_code ilike ${q} or c.file_name ilike ${"%" + q + "%"})` : db``}
       ${sp.set ? db`and c.set_code = ${sp.set.toUpperCase()}` : db``}
       ${sp.year ? db`and extract(year from c.release_date) = ${Number(sp.year)}` : db``}
       ${types ? db`and c.deck_type in ${db(types)}` : category === "other" ? db`and c.deck_type not in ${db(knownTypes)}` : db``}
     order by c.release_date desc nulls last, c.name
     limit 200`;
  const years = await db<{ y: number }[]>`select distinct extract(year from release_date)::int as y from deck_catalog where release_date is not null order by y desc`;
  const ret = `/decks/search?${new URLSearchParams(Object.entries({ q, set: sp.set ?? "", year: sp.year ?? "", category }).filter(([, v]) => v)).toString()}`;

  return (
    <div className="space-y-5">
      <Flash msg={sp.msg} err={sp.err} />

      <Card title="公式ページから取り込む">
        <form className="flex flex-wrap items-end gap-2" action="/decks/search">
          <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-xs text-gray-600">
            公式デッキリストのURL（magic.wizards.com / mtg-jp.com）
            <input name="url" defaultValue={sp.url} required className={input} placeholder="https://magic.wizards.com/en/news/announcements/…-commander-decklists" />
          </label>
          <label className="flex w-28 flex-col gap-1 text-xs text-gray-600">
            セット記号（任意）
            <input name="set" defaultValue={sp.set} className={input} placeholder="EOC" />
          </label>
          <button className="rounded-md bg-gray-900 px-3 py-1.5 text-sm text-white">内容を確認</button>
        </form>
        <p className="mt-2 text-xs text-gray-500">
          公式ページのカード名・枚数を正とし、セット記号・番号・Foil 仕様は MTGJSON の同名デッキで補完します。一致しないカードは推測せず確認待ちにします。
        </p>
        {sp.url && <div className="mt-4"><OfficialPreview url={sp.url} set={sp.set} /></div>}
      </Card>

      <Card
        title="デッキを検索（MTGJSON のデッキ一覧）"
        actions={
          <form action={refreshCatalogAction} className="flex items-center gap-2 text-xs text-gray-500">
            <span>{catalogCount}件・更新 {formatJst(at)}</span>
            <Submit pendingText="取得中…">一覧を更新</Submit>
          </form>
        }
      >
        <form className="mb-3 flex flex-wrap items-end gap-2" action="/decks/search">
          <input name="q" defaultValue={q} placeholder="デッキ名・セット記号" className={`${input} min-w-[220px] flex-1`} />
          <select name="category" defaultValue={category} className={input}>
            <option value="all">すべての製品</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select name="year" defaultValue={sp.year ?? ""} className={input}>
            <option value="">発売年</option>
            {years.map((y) => <option key={y.y} value={y.y}>{y.y}年</option>)}
          </select>
          <input name="set" defaultValue={sp.url ? "" : sp.set} placeholder="セット" className={`${input} w-24`} />
          <button className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm">検索</button>
        </form>
        {catalogCount === 0 ? (
          <Empty>デッキ一覧がまだありません。「一覧を更新」を押して MTGJSON から取得してください。</Empty>
        ) : rows.length === 0 ? (
          <Empty>該当するデッキがありません</Empty>
        ) : (
          <form action={registerMtgjsonAction}>
            <input type="hidden" name="return" value={ret} />
            <div className="-mx-4 max-h-[560px] overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0">
                  <tr><Th>{""}</Th><Th>デッキ名</Th><Th>セット</Th><Th>種別</Th><Th>発売日</Th><Th>登録状況</Th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.file_name} className="hover:bg-gray-50">
                      <Td><input type="checkbox" name="file" value={r.file_name} /></Td>
                      <Td className="font-medium">{r.name}</Td>
                      <Td>{r.set_code}</Td>
                      <Td className="text-gray-600">{r.deck_type}</Td>
                      <Td className="tabular-nums text-gray-600">{r.release_date ?? "—"}</Td>
                      <Td>
                        {(r.reg ?? []).map((l) => <Badge key={l} tone="blue">{l === "ja" ? "日本語版" : "英語版"} 登録済み</Badge>)}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select name="language" className={input} defaultValue="ja">
                <option value="ja">日本語版として登録</option>
                <option value="en">英語版として登録</option>
              </select>
              <Submit primary pendingText="登録中…">選んだデッキを一括登録</Submit>
              <span className="text-xs text-gray-500">MTGJSON から登録したデッキは公式ページとの照合が無いため、可能なら上の公式ページからの取り込みをおすすめします。</span>
            </div>
          </form>
        )}
      </Card>

      <Card title="CSVで手動登録">
        <form action={importDeckCsvAction} className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <input name="name" required placeholder="デッキ名" className={`${input} w-full`} />
            <div className="flex gap-2">
              <input name="set_code" placeholder="セット記号" className={`${input} w-28`} />
              <input name="expected" type="number" defaultValue={100} min={1} className={`${input} w-24`} title="想定枚数" />
              <select name="category" className={input} defaultValue="commander">
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select name="language" className={input} defaultValue="ja">
                <option value="ja">日本語版</option>
                <option value="en">英語版</option>
              </select>
            </div>
            <input name="official_url" placeholder="公式URL（任意・差分検知に使用）" className={`${input} w-full`} />
            <input name="file" type="file" accept=".csv,text/csv" className="block text-sm" />
            <Submit primary>CSVから登録</Submit>
          </div>
          <div className="space-y-1">
            <textarea name="text" rows={7} placeholder={"ファイルの代わりに貼り付けもできます\n枚数,カード名,セット,番号,仕様,区分\n1,\"Hearthhull, the Worldseed\",EOC,1,foil,統率者\n1,Sol Ring,EOC,57,nonfoil,メイン"} className={`${input} w-full font-mono text-xs`} />
            <p className="text-xs text-gray-500">
              列: 枚数・カード名（必須）、セット・番号・仕様（nonfoil / foil / etched）、区分（統率者 / メイン / トークン / ディスプレイ）、日本語名。
              セット・番号・仕様が無い行は確認待ちになります。<Link href="/admin#review" className="underline">確認待ちの一覧</Link>
            </p>
          </div>
        </form>
      </Card>
    </div>
  );
}
