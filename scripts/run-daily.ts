/**
 * 価格更新をコマンドラインから実行します（GitHub Actions やサーバーの cron 用）。
 *   DATABASE_URL=... npm run job:daily
 */
import { closeDb } from "../src/lib/db";
import { runPriceUpdate } from "../src/lib/jobs/daily";

const timeBudgetMs = Number(process.env.JOB_TIME_BUDGET_MS ?? 3 * 3600_000);
runPriceUpdate({ kind: "daily", trigger: "cli", timeBudgetMs })
  .then(async (r) => {
    console.log(JSON.stringify(r));
    await closeDb();
    process.exit(!r.skipped && r.status === "failed" ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
