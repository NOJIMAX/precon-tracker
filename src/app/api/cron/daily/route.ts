import { NextResponse, type NextRequest } from "next/server";
import { runPriceUpdate } from "@/lib/jobs/daily";

// Vercel Cron から毎朝 6:00（日本時間）に呼ばれる。vercel.json を参照
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runPriceUpdate({ kind: "daily", trigger: "cron", timeBudgetMs: 270_000 });
  return NextResponse.json(result);
}
