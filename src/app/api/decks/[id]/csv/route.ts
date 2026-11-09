import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { deckCardPrices } from "@/lib/prices/totals";
import { STATUS_LABEL, type PriceStatus } from "@/lib/prices/types";
import { jstDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const esc = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [deck] = await sql()<{ name: string; language: string }[]>`select name, language from decks where id = ${id}`;
  if (!deck) return NextResponse.json({ error: "not found" }, { status: 404 });
  const date = jstDate();
  const rows = await deckCardPrices(id, date);
  const header = ["区分", "カード名", "日本語名", "セット", "番号", "言語", "仕様", "枚数", "単価", "小計", "前日単価", "前日比", "価格日付", "最新取得結果", "集計対象", "晴れる屋URL"];
  const lines = rows.map((r) => [
    r.section, r.card_name, r.name_ja, r.set_code, r.collector_number, r.language, r.finish, r.quantity,
    r.unit_price, r.unit_price != null ? r.unit_price * r.quantity : "",
    r.prev_unit_price, r.unit_price != null && r.prev_unit_price != null ? r.unit_price - r.prev_unit_price : "",
    r.price_date, r.last_status ? STATUS_LABEL[r.last_status as PriceStatus] : "未取得", r.included ? "対象" : "対象外", r.product_url,
  ].map(esc).join(","));
  const body = "﻿" + [header.join(","), ...lines].join("\r\n");
  const filename = encodeURIComponent(`${deck.name}_${deck.language}_${date}.csv`);
  return new NextResponse(body, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${filename}` },
  });
}
