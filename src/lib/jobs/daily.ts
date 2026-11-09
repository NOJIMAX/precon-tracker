import { getSetting, sql } from "../db";
import { checkDeckForChanges } from "../decks/importer";
import { HareruyaAutoAdapter, hareruyaAutoEnabled } from "../prices/hareruya";
import { recordPrice } from "../prices/record";
import { DEFAULT_SOURCE, snapshotAllDecks } from "../prices/totals";
import { RETRYABLE, type LookupResult, type PriceAdapter, type PrintingForLookup } from "../prices/types";
import { sleep } from "../http";
import { jstDate } from "../time";
import { finishJob, logJob, startJob } from "./jobs";

export interface RunOptions {
  kind?: "daily" | "manual";
  trigger?: string;
  /** テストや将来の取得元追加のために差し替え可能 */
  adapter?: PriceAdapter | null;
  sourceId?: string;
  /** この時間を超えたら残りを打ち切る（Vercel の実行時間上限対策） */
  timeBudgetMs?: number;
  /** 公式デッキリストの変更チェックを1回に何件まで行うか */
  deckChecksPerRun?: number;
  today?: string;
  retryDelayMs?: number;
}

/** 自動取得が有効な取得元のアダプター。無効なら null（CSV/手入力運用） */
export async function activeAdapter(sourceId = DEFAULT_SOURCE): Promise<PriceAdapter | null> {
  const [src] = await sql()<{ fetch_mode: string }[]>`select fetch_mode from price_sources where id = ${sourceId}`;
  if (src?.fetch_mode !== "auto") return null;
  if (sourceId === "hareruya_buyback" && hareruyaAutoEnabled()) return new HareruyaAutoAdapter();
  return null;
}

/** 価格を取りに行く対象（全デッキの印刷版を重複なしで1回ずつ） */
export async function lookupTargets(sourceId = DEFAULT_SOURCE): Promise<PrintingForLookup[]> {
  const basicPolicy = await getSetting<string>("basic_land_policy", "exclude");
  const rows = await sql()<{ printing_id: string; name_en: string; set_code: string; collector_number: string; language: "ja" | "en"; finish: "nonfoil" | "foil" | "etched"; external_id: string | null; url: string | null }[]>`
    select distinct on (p.id) p.id as printing_id, c.name_en, p.set_code, p.collector_number, p.language, p.finish, sp.external_id, sp.url
      from deck_cards dc
      join card_printings p on p.id = dc.printing_id
      join cards c on c.id = p.card_id
      left join source_products sp on sp.printing_id = p.id and sp.source_id = ${sourceId} and sp.match_status <> 'rejected'
     where dc.section in ('commander','main') and dc.resolution_status = 'resolved'
       and (not dc.is_basic_land or ${basicPolicy} = 'include_if_priced')
     order by p.id`;
  return rows.map((r) => ({
    printingId: r.printing_id,
    name: r.name_en,
    setCode: r.set_code,
    collectorNumber: r.collector_number,
    language: r.language,
    finish: r.finish,
    knownExternalId: r.external_id,
    knownUrl: r.url,
  }));
}

export async function runPriceUpdate(opts: RunOptions = {}) {
  const kind = opts.kind ?? "daily";
  const sourceId = opts.sourceId ?? DEFAULT_SOURCE;
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? Number(process.env.JOB_TIME_BUDGET_MS ?? 270_000);
  const jobId = await startJob(kind, opts.trigger ?? "cli");
  if (!jobId) return { skipped: true as const, reason: "価格更新が実行中です" };

  let success = 0, failure = 0, retries = 0;
  let fatal: string | undefined;
  const today = opts.today ?? jstDate();
  // 日付を指定した実行（再集計・テスト）では、その日の記録として保存する
  const observedAt = opts.today ? new Date(`${opts.today}T06:00:00+09:00`) : undefined;
  try {
    const adapter = opts.adapter === undefined ? await activeAdapter(sourceId) : opts.adapter;
    if (!adapter) {
      await logJob(jobId, { level: "info", message: "自動取得は無効です（CSV取込・手入力の価格で集計します）" });
    } else {
      const targets = await lookupTargets(sourceId);
      await logJob(jobId, { level: "info", message: `${targets.length}種類のカード版を取得します` });
      const retryQueue: PrintingForLookup[] = [];
      const run = async (t: PrintingForLookup, isRetry: boolean) => {
        let r: LookupResult;
        try {
          r = await adapter.lookup(t);
        } catch (e) {
          r = { status: "parse_error", detail: (e as Error).message };
        }
        if (!isRetry && RETRYABLE.includes(r.status)) {
          retryQueue.push(t);
          return;
        }
        // 1件の失敗で全体を止めない
        try {
          await recordPrice({ sourceId, printingId: t.printingId, result: r, method: "auto", jobId, observedAt });
          if (r.status === "ok") success++;
          else failure++;
        } catch (e) {
          failure++;
          await logJob(jobId, { level: "error", message: `記録失敗: ${t.name} ${t.setCode}#${t.collectorNumber}`, error: (e as Error).message });
        }
      };
      let processed = 0;
      for (const t of targets) {
        if (Date.now() - started > budget) break;
        await run(t, false);
        processed++;
      }
      if (retryQueue.length) {
        await sleep(opts.retryDelayMs ?? 10_000);
        for (const t of retryQueue) {
          if (Date.now() - started > budget) break;
          retries++;
          await run(t, true);
        }
      }
      const notDone = targets.length - processed;
      if (notDone > 0) {
        await logJob(jobId, { level: "warn", message: `実行時間の上限のため ${notDone}件は未実行です（次回実行時に取得します）` });
        failure += notDone;
      }
    }

    const n = await snapshotAllDecks(today, sourceId);
    await logJob(jobId, { level: "info", message: `${n}デッキの合計を集計しました（${today}）` });

    // 公式デッキリストの変更チェック（外部アクセスを抑えるため1回に数件、7日ごと）
    const limit = opts.deckChecksPerRun ?? Number(process.env.DECK_CHECKS_PER_RUN ?? 3);
    if (limit > 0) {
      const due = await sql()<{ id: string; name: string }[]>`
        select id, name from decks where (official_url is not null or mtgjson_file is not null)
           and (last_checked_at is null or last_checked_at < now() - interval '7 days')
         order by last_checked_at nulls first limit ${limit}`;
      for (const d of due) {
        try {
          const r = await checkDeckForChanges(d.id);
          if (r.changed) await logJob(jobId, { level: "warn", message: `デッキリストの変更を検知: ${d.name}` });
        } catch (e) {
          await logJob(jobId, { level: "warn", message: `デッキリスト確認に失敗: ${d.name}`, error: (e as Error).message });
        }
      }
    }
  } catch (e) {
    fatal = (e as Error).message;
    await logJob(jobId, { level: "error", message: "更新処理が途中で失敗しました", error: fatal });
  }
  const status = await finishJob(jobId, { success, failure, retries, error: fatal });
  return { skipped: false as const, jobId, status, success, failure, retries };
}
