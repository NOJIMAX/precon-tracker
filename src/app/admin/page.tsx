import Link from "next/link";
import clsx from "clsx";
import { linkProductAction, manualPriceAction, rejectMatchAction, resolveLineAction, retryCardAction, runManualUpdateAction, saveSettingsAction } from "@/app/actions";
import { Flash } from "@/components/flash";
import { Submit } from "@/components/submit";
import { Badge, Card, Empty, input, Notice, Stat, Td, Th, yen } from "@/components/ui";
import { getSetting, sql } from "@/lib/db";
import { FINISH_LABEL, JOB_KIND_LABEL, JOB_STATUS_LABEL, SECTION_LABEL } from "@/lib/labels";
import { activeAdapter } from "@/lib/jobs/daily";
import { hareruyaAutoEnabled, hareruyaSearchUrl } from "@/lib/prices/hareruya";
import type { Candidate } from "@/lib/prices/match";
import { STATUS_LABEL, type PriceStatus } from "@/lib/prices/types";
import { anomalies, failedCards, failedCountsByStatus, lastJob, recentJobs, reviewLines } from "@/lib/queries";
import { formatJst, jstDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const RET = "/admin";

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ status?: string; msg?: string; err?: string }> }) {
  const sp = await searchParams;
  const [jobs, last, counts, failed, review, anom, adapter, settings, autoMatches] = await Promise.all([
    recentJobs(30),
    lastJob(),
    failedCountsByStatus(),
    failedCards(sp.status),
    reviewLines(),
    anomalies(),
    activeAdapter(),
    Promise.all([
      getSetting<string>("basic_land_policy", "exclude"),
      getSetting<number>("price_max_age_days", 7),
      getSetting<number>("anomaly_threshold_pct", 50),
      getSetting<number>("anomaly_min_price_jpy", 300),
    ]),
    sql()<{ id: string; name_en: string; set_code: string; collector_number: string; language: string; finish: string; listed_name: string | null; listed_set_code: string | null; listed_number: string | null; listed_finish: string | null; url: string | null; match_status: string; matched_at: Date }[]>`
      select sp.id, c.name_en, p.set_code, p.collector_number, p.language, p.finish, sp.listed_name, sp.listed_set_code, sp.listed_number, sp.listed_finish,
             sp.url, sp.match_status, sp.matched_at
        from source_products sp join card_printings p on p.id = sp.printing_id join cards c on c.id = p.card_id
       where sp.match_status in ('auto_exact','auto_unique') order by sp.match_status desc, sp.matched_at desc limit 100`,
  ]);
  const total = counts.reduce((s, c) => s + c.n, 0);
  const statusTabs: [string | undefined, string, number][] = [
    [undefined, "すべて", total],
    ["never", "未取得（記録なし）", counts.find((c) => c.status === null)?.n ?? 0],
    ...(Object.keys(STATUS_LABEL) as PriceStatus[]).filter((s) => s !== "ok").map((s) => [s, STATUS_LABEL[s], counts.find((c) => c.status === s)?.n ?? 0] as [string, string, number]),
  ];
  const today = jstDate();

  return (
    <div className="space-y-5">
      <Flash msg={sp.msg} err={sp.err} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="定期更新" value="毎日 6:00" sub={adapter ? "晴れる屋: 自動取得" : "晴れる屋: CSV・手入力（集計のみ）"} />
        <Stat label="直近の実行" value={last.last ? JOB_STATUS_LABEL[last.last.status] : "未実行"} sub={formatJst(last.last?.started_at)} tone={last.last?.status === "failed" ? "bad" : last.last?.status === "partial" ? "warn" : undefined} />
        <Stat label="前回成功日時" value={<span className="text-base">{formatJst(last.lastSuccess?.finished_at)}</span>} />
        <Stat label="価格未取得のカード版" value={total} tone={total ? "warn" : undefined} />
      </div>
      <form action={runManualUpdateAction} className="flex flex-wrap items-center gap-2">
        <Submit primary pendingText="更新中…（数分かかることがあります）">今すぐ更新</Submit>
        <span className="text-xs text-gray-500">
          {adapter ? "晴れる屋から価格を取得し、全デッキの合計を集計します。" : "記録済みの価格で全デッキの合計を集計し直します（晴れる屋へのアクセスはしません）。"}
          {!adapter && hareruyaAutoEnabled() && " ※ HARERUYA_AUTO_FETCH は有効ですが price_sources.fetch_mode が manual です。"}
        </span>
      </form>

      <Card title="価格が取れていないカード" className="scroll-mt-4">
        <div id="failed" className="mb-3 flex flex-wrap gap-1 text-xs">
          {statusTabs.map(([k, label, n]) => (
            <Link key={label} href={k ? `/admin?status=${k}#failed` : "/admin#failed"} className={clsx("rounded px-2 py-1", sp.status === k ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700")}>
              {label} {n}
            </Link>
          ))}
        </div>
        {failed.length === 0 ? (
          <Empty>該当するカードはありません</Empty>
        ) : (
          <div className="-mx-4 -mb-4 overflow-x-auto">
            <table className="w-full">
              <thead><tr><Th>カード</Th><Th>結果・理由</Th><Th>最終成功</Th><Th>対応</Th></tr></thead>
              <tbody>
                {failed.map((f) => {
                  const cands = (Array.isArray(f.candidates) ? f.candidates : []) as Candidate[];
                  return (
                    <tr key={f.printing_id} className="align-top">
                      <Td className="min-w-[200px]">
                        <div className="font-medium">{f.name_en}</div>
                        <div className="text-xs text-gray-500">
                          {f.name_ja} {f.set_code} #{f.collector_number} ・ {f.language === "ja" ? "日本語" : "英語"} ・ {FINISH_LABEL[f.finish]}
                        </div>
                        <div className="text-xs text-gray-400">{f.deck_names.slice(0, 3).join("、")}{f.deck_names.length > 3 ? ` ほか${f.deck_names.length - 3}` : ""}</div>
                      </Td>
                      <Td className="text-xs">
                        <Badge tone={f.last_status ? "red" : "gray"}>{f.last_status ? STATUS_LABEL[f.last_status as PriceStatus] : "未取得"}</Badge>
                        {f.last_detail && <div className="mt-1 text-gray-600">{f.last_detail}</div>}
                        {f.last_attempt_at && <div className="text-gray-400">{formatJst(f.last_attempt_at)}</div>}
                        {cands.length > 0 && (
                          <ul className="mt-1 space-y-1">
                            {cands.slice(0, 5).map((c, i) => (
                              <li key={i} className="flex items-center gap-1">
                                <span>{c.name} [{c.setCode ?? "?"}] {c.collectorNumber ? `#${c.collectorNumber}` : ""} {c.finish} {yen(c.priceJpy)}</span>
                                {c.url && (
                                  <form action={linkProductAction}>
                                    <input type="hidden" name="printing_id" value={f.printing_id} /><input type="hidden" name="url" value={c.url} /><input type="hidden" name="return" value={RET} />
                                    <button className="rounded border border-gray-300 px-1.5 text-[11px]">これで確定</button>
                                  </form>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-xs">{f.last_ok_price != null ? <>{yen(f.last_ok_price)}<div className="text-gray-400">{f.last_ok_date}</div></> : "—"}</Td>
                      <Td className="min-w-[320px] space-y-1.5 text-xs">
                        <form action={manualPriceAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="printing_id" value={f.printing_id} /><input type="hidden" name="return" value={RET} />
                          <input name="price" placeholder="買取価格" className={`${input} w-24 py-1 text-xs`} inputMode="numeric" />
                          <input name="date" type="date" defaultValue={today} max={today} className={`${input} py-1 text-xs`} />
                          <label className="flex items-center gap-0.5"><input type="checkbox" name="not_listed" />価格なし</label>
                          <button className="rounded border border-gray-300 px-2 py-1">記録</button>
                        </form>
                        <form action={linkProductAction} className="flex items-center gap-1">
                          <input type="hidden" name="printing_id" value={f.printing_id} /><input type="hidden" name="return" value={RET} />
                          <input name="url" placeholder="晴れる屋の商品URLを紐づけ" defaultValue={f.product_url ?? ""} className={`${input} w-56 py-1 text-xs`} />
                          <button className="rounded border border-gray-300 px-2 py-1">紐づけ</button>
                        </form>
                        <div className="flex flex-wrap gap-2">
                          <a href={hareruyaSearchUrl(f.name_en, f.language as "ja" | "en")} target="_blank" rel="noreferrer" className="underline">晴れる屋で検索 ↗</a>
                          {f.source_product_id && (
                            <form action={rejectMatchAction}>
                              <input type="hidden" name="source_product_id" value={f.source_product_id} /><input type="hidden" name="return" value={RET} />
                              <button className="text-red-700 underline">紐づけを外す</button>
                            </form>
                          )}
                          {adapter && (
                            <form action={retryCardAction}><input type="hidden" name="printing_id" value={f.printing_id} /><button className="underline">再取得</button></form>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div id="review" className="scroll-mt-4">
        <Card title={`印刷仕様の確認待ち（${review.length}）`}>
          {review.length === 0 ? (
            <Empty>確認待ちのカードはありません</Empty>
          ) : (
            <div className="-mx-4 -my-4 overflow-x-auto">
              <table className="w-full">
                <thead><tr><Th>デッキ</Th><Th>カード</Th><Th>理由</Th><Th>セット・番号・仕様を確定</Th></tr></thead>
                <tbody>
                  {review.map((r) => (
                    <tr key={r.id}>
                      <Td><Link href={`/decks/${r.deck_id}`} className="hover:underline">{r.deck_name}</Link> <span className="text-xs text-gray-400">{r.language === "ja" ? "日" : "英"}</span></Td>
                      <Td>{r.quantity} {r.card_name} {r.section !== "main" && <Badge>{SECTION_LABEL[r.section]}</Badge>}</Td>
                      <Td className="text-xs text-gray-600">{r.note ?? "—"}</Td>
                      <Td>
                        <form action={resolveLineAction} className="flex flex-wrap items-center gap-1 text-xs">
                          <input type="hidden" name="deck_card_id" value={r.id} /><input type="hidden" name="return" value="/admin#review" />
                          <input name="set_code" placeholder="セット" className={`${input} w-16 py-1 text-xs`} required />
                          <input name="number" placeholder="番号" className={`${input} w-16 py-1 text-xs`} required />
                          <select name="finish" className={`${input} py-1 text-xs`} defaultValue="">
                            <option value="" disabled>仕様</option><option value="nonfoil">通常</option><option value="foil">Foil</option><option value="etched">エッチング</option>
                          </select>
                          <button className="rounded border border-gray-300 px-2 py-1">確定</button>
                        </form>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`大きく変動した価格（直近7日・${anom.length}件）`}>
          {anom.length === 0 ? <Empty>ありません</Empty> : (
            <ul className="max-h-72 space-y-1 overflow-auto text-sm">
              {anom.map((a, i) => (
                <li key={i} className="flex justify-between gap-2">
                  <span className="truncate">{a.name_en} <span className="text-xs text-gray-500">{a.set_code} #{a.collector_number} {a.finish !== "nonfoil" ? a.finish : ""} {a.language}</span></span>
                  <span className="shrink-0 tabular-nums">{yen(a.previous_price_jpy)} → <b>{yen(a.price_jpy)}</b> <span className="text-xs text-gray-400">{a.observed_date}</span></span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-gray-500">誤照合が疑われる場合は、下の「自動照合の一覧」で紐づけを外すか、手入力で正しい価格を記録してください。</p>
        </Card>

        <Card title="自動照合の一覧（誤照合の修正）">
          {autoMatches.length === 0 ? <Empty>自動で照合した商品はありません</Empty> : (
            <ul className="max-h-72 space-y-1 overflow-auto text-xs">
              {autoMatches.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {m.name_en} {m.set_code}#{m.collector_number} {m.finish} {m.language} → {m.url ? <a href={m.url} target="_blank" rel="noreferrer" className="underline">{m.listed_name} [{m.listed_set_code}] {m.listed_number ?? ""} {m.listed_finish}</a> : `${m.listed_name} [${m.listed_set_code}]`}
                    {m.match_status === "auto_unique" && <span className="ml-1"><Badge tone="amber">番号なし一致</Badge></span>}
                  </span>
                  <form action={rejectMatchAction}>
                    <input type="hidden" name="source_product_id" value={m.id} /><input type="hidden" name="return" value={RET} />
                    <button className="shrink-0 text-red-700 underline">外す</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="更新履歴">
        {jobs.length === 0 ? <Empty>まだ実行されていません</Empty> : (
          <div className="-mx-4 -my-4 overflow-x-auto">
            <table className="w-full">
              <thead><tr><Th>開始</Th><Th>種類</Th><Th>結果</Th><Th className="text-right">成功</Th><Th className="text-right">失敗</Th><Th className="text-right">再試行</Th><Th>ログ</Th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="align-top">
                    <Td className="whitespace-nowrap tabular-nums">{formatJst(j.started_at)}</Td>
                    <Td>{JOB_KIND_LABEL[j.kind] ?? j.kind}<div className="text-xs text-gray-400">{j.trigger}</div></Td>
                    <Td><Badge tone={j.status === "succeeded" ? "green" : j.status === "partial" ? "amber" : j.status === "failed" ? "red" : "blue"}>{JOB_STATUS_LABEL[j.status]}</Badge></Td>
                    <Td className="text-right tabular-nums">{j.success_count}</Td>
                    <Td className="text-right tabular-nums">{j.failure_count}</Td>
                    <Td className="text-right tabular-nums">{j.retry_count}</Td>
                    <Td className="text-xs">
                      {j.error && <div className="text-red-700">{j.error}</div>}
                      <details>
                        <summary className="cursor-pointer text-gray-500">{j.log.length}件</summary>
                        <ul className="mt-1 max-h-48 overflow-auto">
                          {j.log.map((l, i) => (
                            <li key={i} className={l.level === "error" ? "text-red-700" : l.level === "warn" ? "text-amber-700" : "text-gray-600"}>
                              {l.message}{l.error ? `: ${l.error}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="設定">
        <form action={saveSettingsAction} className="grid gap-3 text-sm md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600">基本土地の扱い</span>
            <select name="basic_land_policy" defaultValue={settings[0]} className={input}>
              <option value="exclude">合計に含めない</option>
              <option value="include_if_priced">買取価格があれば含める（無ければ未取得として数えない）</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600">価格の有効日数（これより古い成功価格は合計に使わない）</span>
            <input name="price_max_age_days" type="number" min={1} max={365} defaultValue={settings[1]} className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600">異常値とみなす変動率（%）</span>
            <input name="anomaly_threshold_pct" type="number" min={1} defaultValue={settings[2]} className={input} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-600">異常値判定の下限額（円）</span>
            <input name="anomaly_min_price_jpy" type="number" min={0} defaultValue={settings[3]} className={input} />
          </label>
          <div className="md:col-span-2"><Submit primary>保存して再集計</Submit></div>
        </form>
        {!adapter && (
          <div className="mt-4">
            <Notice tone="blue">
              晴れる屋の自動取得は無効です。晴れる屋から許可を得た場合のみ、環境変数 <code>HARERUYA_AUTO_FETCH=enabled</code> を設定し、
              データベースで <code>update price_sources set fetch_mode = &apos;auto&apos; where id = &apos;hareruya_buyback&apos;</code> を実行してください（README 参照）。
            </Notice>
          </div>
        )}
      </Card>
    </div>
  );
}
