import postgres from "postgres";

/**
 * PostgreSQL 接続（Supabase の接続文字列をそのまま使います）。
 * - 本番: DATABASE_URL（Supabase の "Transaction pooler" の URL を推奨）
 * - テスト: TEST_DATABASE_URL（本番と別のデータベース）
 */
type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __sql?: Sql };

export function databaseUrl(): string {
  const url = process.env.NODE_ENV === "test" ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      process.env.NODE_ENV === "test"
        ? "TEST_DATABASE_URL が設定されていません（テストは本番DBでは実行しません）"
        : "DATABASE_URL が設定されていません（.env.example を参照）",
    );
  }
  if (process.env.NODE_ENV === "test" && url === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL と DATABASE_URL が同じです。テスト用には別のデータベースを指定してください");
  }
  return url;
}

export function sql(): Sql {
  if (!globalForDb.__sql) {
    globalForDb.__sql = postgres(databaseUrl(), {
      max: Number(process.env.DB_POOL_MAX ?? 5),
      // Supabase の transaction pooler では prepared statement が使えないため無効化
      prepare: false,
      idle_timeout: 20,
      types: { bigint: postgres.BigInt },
    });
  }
  return globalForDb.__sql;
}

export async function closeDb() {
  if (globalForDb.__sql) {
    await globalForDb.__sql.end({ timeout: 5 });
    globalForDb.__sql = undefined;
  }
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await sql()<{ value: T }[]>`select value from app_settings where key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await sql()`insert into app_settings (key, value) values (${key}, ${sql().json(value as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
