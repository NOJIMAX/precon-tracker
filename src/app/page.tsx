import Link from "next/link";
import clsx from "clsx";
import { Badge, Card, ChangeCell, Empty, Stat, Td, Th, yen } from "@/components/ui";
import { failedCountsByStatus, lastJob, listDecks, type DeckListItem } from "@/lib/queries";
import { formatJst } from "@/lib/time";
import { JOB_STATUS_LABEL } from "@/lib/labels";

export const dynamic = "force-dynamic";

function TotalCell({ d }: { d: DeckListItem }) {
  const s = d.summary;
  if (!s || s.total == null) return <span className="text-gray-400">未集計</span>;
  return (
    <span className="tabular-nums">
      {s.isComplete ? yen(s.total) : <>小計 {yen(s.total)}</>}
      {!s.isComplete && <span className="ml-1 text-xs text-amber-700">未取得 {s.missingCount}</span>}
    </span>
  );
}

function Ranking({ title, items, value }: { title: string; items: DeckListItem[]; value: (d: DeckListItem) => React.ReactNode }) {
  return (
    <Card title={title}>
      {items.length === 0 ? (
        <Empty>データがありません</Empty>
      ) : (
        <ol className="space-y-1.5 text-sm">
          {items.map((d, i) => (
            <li key={d.id} className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="mr-1.5 inline-block w-4 text-right text-xs text-gray-400">{i + 1}</span>
                <Link href={`/decks/${d.id}`} className="hover:underline">{d.name}</Link>
                <span className="ml-1 text-xs text-gray-400">{d.language === "ja" ? "日" : "英"}</span>
              </span>
              <span className="shrink-0">{value(d)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const [decks, jobs, failed] = await Promise.all([listDecks(), lastJob(), failedCountsByStatus()]);
  const failedTotal = failed.reduce((s, r) => s + r.n, 0);
  const withTotal = decks.filter((d) => d.summary?.total != null);
  const byTotal = [...withTotal].sort((a, b) => b.summary!.total! - a.summary!.total!).slice(0, 10);
  const withD1 = withTotal.filter((d) => d.summary!.d1);
  const up = withD1.filter((d) => d.summary!.d1!.yen > 0).sort((a, b) => b.summary!.d1!.yen - a.summary!.d1!.yen).slice(0, 10);
  const down = withD1.filter((d) => d.summary!.d1!.yen < 0).sort((a, b) => a.summary!.d1!.yen - b.summary!.d1!.yen).slice(0, 10);
  const last = jobs.last;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="登録デッキ数" value={decks.length} sub={`確認待ち ${decks.filter((d) => d.status === "needs_review").length}件`} />
        <Stat
          label="最新の価格更新"
          value={last ? JOB_STATUS_LABEL[last.status] ?? last.status : "未実行"}
          tone={last?.status === "failed" ? "bad" : last?.status === "partial" ? "warn" : undefined}
          sub={last ? formatJst(last.started_at) : "—"}
        />
        <Stat label="前回成功" value={jobs.lastSuccess ? formatJst(jobs.lastSuccess.finished_at) : "—"} />
        <Stat label="価格未取得のカード" value={failedTotal} tone={failedTotal ? "warn" : undefined} sub={<Link href="/admin#failed" className="underline">一覧を見る</Link>} />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Ranking title="合計買取価格ランキング" items={byTotal} value={(d) => <TotalCell d={d} />} />
        <Ranking title="前日比 上昇" items={up} value={(d) => <ChangeCell c={d.summary!.d1} />} />
        <Ranking title="前日比 下落" items={down} value={(d) => <ChangeCell c={d.summary!.d1} />} />
      </div>

      <Card
        title={`デッキ一覧（${decks.length}）`}
        actions={
          <div className="flex gap-1 text-xs">
            <Link href="/" className={clsx("rounded px-2 py-1", view !== "cards" ? "bg-gray-900 text-white" : "bg-gray-100")}>表</Link>
            <Link href="/?view=cards" className={clsx("rounded px-2 py-1", view === "cards" ? "bg-gray-900 text-white" : "bg-gray-100")}>カード</Link>
          </div>
        }
      >
        {decks.length === 0 ? (
          <Empty>
            まだデッキが登録されていません。<Link href="/decks/search" className="underline">デッキ検索・登録</Link>から追加してください。
          </Empty>
        ) : view === "cards" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {decks.map((d) => (
              <Link key={d.id} href={`/decks/${d.id}`} className="flex gap-3 rounded-md border border-gray-200 p-3 hover:border-gray-400">
                {d.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.image_url.replace("/normal/", "/small/")} alt="" className="h-24 w-[68px] shrink-0 rounded object-cover" loading="lazy" />
                ) : (
                  <div className="h-24 w-[68px] shrink-0 rounded bg-gray-100" />
                )}
                <div className="min-w-0 text-sm">
                  <div className="truncate font-medium">{d.name}</div>
                  <div className="text-xs text-gray-500">{d.set_code} ・ {d.language === "ja" ? "日本語版" : "英語版"}</div>
                  <div className="mt-2"><TotalCell d={d} /></div>
                  <div className="text-xs"><ChangeCell c={d.summary?.d1 ?? null} /></div>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="-mx-4 -my-4 overflow-x-auto">
            <table className="w-full whitespace-nowrap">
              <thead>
                <tr>
                  <Th>デッキ</Th><Th>セット</Th><Th>言語</Th><Th className="text-right">合計買取価格</Th>
                  <Th className="text-right">前日比</Th><Th className="text-right">7日前比</Th><Th className="text-right">取得率</Th><Th>状態</Th>
                </tr>
              </thead>
              <tbody>
                {decks.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <Td><Link href={`/decks/${d.id}`} className="font-medium hover:underline">{d.name}</Link></Td>
                    <Td className="text-gray-600">{d.set_code ?? "—"}</Td>
                    <Td>{d.language === "ja" ? "日本語" : "英語"}</Td>
                    <Td className="text-right"><TotalCell d={d} /></Td>
                    <Td className="text-right"><ChangeCell c={d.summary?.d1 ?? null} /></Td>
                    <Td className="text-right"><ChangeCell c={d.summary?.d7 ?? null} /></Td>
                    <Td className="text-right tabular-nums">{d.summary?.successRate != null ? `${Math.round(d.summary.successRate * 100)}%` : "—"}</Td>
                    <Td>
                      {d.diff_detected_at ? <Badge tone="red">公式リスト変更</Badge> : d.status === "needs_review" ? <Badge tone="amber">確認待ち</Badge> : <Badge tone="green">検証済み</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
