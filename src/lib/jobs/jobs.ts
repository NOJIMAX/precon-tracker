import { sql } from "../db";

export type JobKind = "daily" | "manual" | "import" | "deck_check";

/** 異常終了で「実行中」のまま残ったジョブを失敗扱いにする時間 */
const STALE_MINUTES = Number(process.env.JOB_STALE_MINUTES ?? 120);

/**
 * ジョブを開始します。同じ種類のジョブが実行中なら null（二重実行防止）。
 * daily と manual は同じ価格更新なので、互いに排他にします。
 */
export async function startJob(kind: JobKind, trigger: string): Promise<string | null> {
  const db = sql();
  await db`update update_jobs set status = 'failed', finished_at = now(), error = '実行中のまま停止していたため打ち切り'
           where status = 'running' and started_at < now() - make_interval(mins => ${STALE_MINUTES})`;
  if (kind === "daily" || kind === "manual") {
    const other = kind === "daily" ? "manual" : "daily";
    const [r] = await db`select 1 from update_jobs where kind = ${other} and status = 'running'`;
    if (r) return null;
  }
  try {
    const [row] = await db<{ id: string }[]>`insert into update_jobs (kind, trigger) values (${kind}, ${trigger}) returning id`;
    return row.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return null; // 一意制約違反 = 実行中
    throw e;
  }
}

export async function logJob(id: string, entry: { level: "info" | "warn" | "error"; message: string; [k: string]: unknown }) {
  const db = sql();
  await db`update update_jobs set log = log || ${db.json([{ at: new Date().toISOString(), ...entry }] as never)} where id = ${id}`;
}

export async function finishJob(
  id: string,
  r: { success: number; failure: number; target?: number; retries?: number; error?: string },
) {
  const status = r.error && r.success === 0 ? "failed" : r.failure > 0 || r.error ? "partial" : "succeeded";
  await sql()`update update_jobs set status = ${status}, finished_at = now(), success_count = ${r.success},
                failure_count = ${r.failure}, target_count = ${r.target ?? r.success + r.failure},
                retry_count = ${r.retries ?? 0}, error = ${r.error ?? null}
              where id = ${id}`;
  return status;
}
