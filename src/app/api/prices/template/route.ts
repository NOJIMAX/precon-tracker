import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { hareruyaSearchUrl } from "@/lib/prices/hareruya";
import { DEFAULT_SOURCE } from "@/lib/prices/totals";
import { jstDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 価格入力用のCSVテンプレート。登録デッキの集計対象カード版を1行ずつ出力します。
 *   ?scope=missing … 今日の価格がまだ無いものだけ（既定）
 *   ?scope=all     … すべて
 *   ?deck=<id>     … 1デッキに限定
 */
export async function GET(req: NextRequest) {
  const scope = req.nextUrl.searchParams.get("scope") ?? "missing";
  const deck = req.nextUrl.searchParams.get("deck");
  const db = sql();
  const today = jstDate();
  const rows = await db<{ name_en: string; name_ja: string | null; set_code: string; collector_number: string; language: string; finish: string; url: string | null; last_ok: number | null }[]>`
    select distinct on (p.id) c.name_en, c.name_ja, p.set_code, p.collector_number, p.language, p.finish, sp.url, pl.last_ok_price_jpy as last_ok
      from deck_cards dc join card_printings p on p.id = dc.printing_id join cards c on c.id = p.card_id
      left join source_products sp on sp.printing_id = p.id and sp.source_id = ${DEFAULT_SOURCE} and sp.match_status <> 'rejected'
      left join price_latest pl on pl.printing_id = p.id and pl.source_id = ${DEFAULT_SOURCE}
     where dc.section in ('commander','main') and not dc.is_basic_land
       ${deck && /^[0-9a-f-]{36}$/i.test(deck) ? db`and dc.deck_id = ${deck}` : db``}
       ${scope === "missing" ? db`and not exists (select 1 from price_history ph where ph.printing_id = p.id and ph.source_id = ${DEFAULT_SOURCE} and ph.observed_date = ${today} and ph.status in ('ok','not_listed'))` : db``}
     order by p.id`;
  rows.sort((a, b) => a.set_code.localeCompare(b.set_code) || a.collector_number.localeCompare(b.collector_number, undefined, { numeric: true }));
  const header = ["カード名", "日本語名", "セット", "番号", "言語", "仕様", "買取価格", "URL", "取得日時", "前回価格", "晴れる屋検索"];
  const lines = rows.map((r) =>
    [r.name_en, r.name_ja, r.set_code, r.collector_number, r.language === "ja" ? "JP" : "EN", r.finish, "", r.url, "", r.last_ok,
     hareruyaSearchUrl(r.name_en, r.language as "ja" | "en")].map(esc).join(","),
  );
  const body = "﻿" + [header.join(","), ...lines].join("\r\n");
  return new NextResponse(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="price-input_${today}.csv"` },
  });
}
