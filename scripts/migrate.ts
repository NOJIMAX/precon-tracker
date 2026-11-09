/**
 * supabase/migrations/*.sql を順番に適用します（適用済みはスキップ）。
 *   DATABASE_URL=... npm run db:migrate
 * Supabase CLI を使う場合は `supabase db push` でも同じファイルが適用されます。
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

export async function migrate(url: string, log = console.log) {
  const db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await db`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set((await db<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const body = fs.readFileSync(path.join(dir, f), "utf8");
      await db.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${f})`;
      });
      log(`applied ${f}`);
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.argv.includes("--test") ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL（--test の場合は TEST_DATABASE_URL）を設定してください");
    process.exit(1);
  }
  migrate(url).then(() => console.log("migrations up to date"), (e) => {
    console.error(e);
    process.exit(1);
  });
}
