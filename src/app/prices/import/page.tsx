import { importPriceCsvAction } from "@/app/actions";
import { Flash } from "@/components/flash";
import { Submit } from "@/components/submit";
import { btn, Card, input, Notice } from "@/components/ui";
import { sql } from "@/lib/db";
import type { JobRow } from "@/lib/queries";
import { formatJst } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function PriceImportPage({ searchParams }: { searchParams: Promise<{ job?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const [job] = sp.job && /^[0-9a-f-]{36}$/i.test(sp.job)
    ? await sql()<JobRow[]>`select * from update_jobs where id = ${sp.job}`
    : await sql()<JobRow[]>`select * from update_jobs where kind = 'import' order by started_at desc limit 1`;
  const [src] = await sql()<{ fetch_mode: string }[]>`select fetch_mode from price_sources where id = 'hareruya_buyback'`;
  const warnings = (job?.log ?? []).filter((l) => l.level !== "info" || /行目/.test(l.message));

  return (
    <div className="space-y-5">
      <Flash msg={sp.msg} err={sp.err} />
      <Notice tone="blue">
        晴れる屋の買取価格は現在 <b>{src?.fetch_mode === "auto" ? "自動取得" : "CSV取込・手入力"}</b> で記録しています。
        {src?.fetch_mode !== "auto" && " 晴れる屋は公開APIが無く、自動取得の許可を確認できていないため、毎朝の定期処理は記録済みの価格でデッキ合計を集計します。"}
      </Notice>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. 入力用CSVをダウンロード">
          <p className="text-sm text-gray-700">登録デッキの集計対象カードを、セット・番号・言語・仕様つきで書き出します。「買取価格」列を埋めて取り込んでください。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a href="/api/prices/template?scope=missing" className={btn}>今日まだ価格が無いカード</a>
            <a href="/api/prices/template?scope=all" className={btn}>すべてのカード</a>
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-gray-600">
            <li>「晴れる屋検索」列のURLで買取ページを開けます。商品ページのURLを「URL」列に入れると、次回から照合に使われます。</li>
            <li>価格が載っていないカードは「-」と入力すると「価格非公開」として記録します（0円にはしません）。</li>
            <li>空欄の行は読み飛ばします。途中まで入力したファイルでも取り込めます。</li>
          </ul>
        </Card>

        <Card title="2. CSVを取り込む">
          <form action={importPriceCsvAction} className="space-y-2">
            <input name="file" type="file" accept=".csv,text/csv" className="block text-sm" />
            <textarea
              name="text"
              rows={6}
              className={`${input} w-full font-mono text-xs`}
              placeholder={"または貼り付け\nカード名,セット,番号,言語,仕様,買取価格,URL,取得日時\nSol Ring,EOC,57,JP,nonfoil,300,,2026-11-09 10:00"}
            />
            <Submit primary pendingText="取り込み中…">取り込む</Submit>
          </form>
          <p className="mt-2 text-xs text-gray-500">
            必須列: カード名・セット・言語（JP / EN）・仕様（nonfoil / foil / etched）・買取価格。番号は推奨です（無い場合は、登録済みの版から一意に決まるときだけ採用します）。
            同じ日に同じカードを取り込み直すと上書きされます（履歴は1日1件）。
          </p>
        </Card>
      </div>

      {job && (
        <Card title={`取込結果（${formatJst(job.started_at)}）`}>
          <p className="text-sm">
            取込 {job.success_count}件 ／ 取り込めなかった行 {job.failure_count}件
          </p>
          {warnings.length > 0 && (
            <ul className="mt-2 max-h-80 space-y-0.5 overflow-auto text-xs">
              {warnings.map((w, i) => (
                <li key={i} className={w.level === "warn" ? "text-red-700" : "text-amber-700"}>{w.message}</li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
