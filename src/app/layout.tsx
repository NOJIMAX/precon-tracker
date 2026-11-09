import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "プレコン買取トラッカー", description: "構築済みデッキの買取価格トラッカー" };

const nav = [
  { href: "/", label: "ダッシュボード" },
  { href: "/decks/search", label: "デッキ検索・登録" },
  { href: "/prices/import", label: "価格取込" },
  { href: "/admin", label: "管理" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2.5">
            <Link href="/" className="font-semibold text-gray-900">プレコン買取トラッカー</Link>
            <nav className="flex flex-wrap gap-1 text-sm">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="rounded px-2.5 py-1 text-gray-600 hover:bg-gray-100 hover:text-gray-900">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
