import { NextResponse, type NextRequest } from "next/server";

/**
 * 簡易のアクセス制限（Basic 認証）。APP_BASIC_AUTH="ユーザー名:パスワード" を設定すると有効になります。
 * 定期実行の /api/cron/* は CRON_SECRET で別途保護しているため対象外です。
 */
export function proxy(req: NextRequest) {
  const cred = process.env.APP_BASIC_AUTH;
  if (!cred) return NextResponse.next();
  const header = req.headers.get("authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme === "Basic" && value && atob(value) === cred) return NextResponse.next();
  return new NextResponse("認証が必要です", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="precon-tracker", charset="UTF-8"' } });
}

export const config = {
  matcher: ["/((?!api/cron|_next/static|_next/image|favicon.ico).*)"],
};
