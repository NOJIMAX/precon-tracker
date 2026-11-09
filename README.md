# プレコン買取トラッカー

MTG の公式構築済みデッキ（第一段階は統率者デッキ）の収録カードを印刷版単位で保存し、晴れる屋の買取価格を日付つきで記録して、デッキごとの合計買取価格と値動きを追うための社内向け Web アプリです。

- Next.js 16（App Router）/ TypeScript / Tailwind CSS
- Supabase（PostgreSQL）
- 毎朝 6:00（日本時間）の定期処理：Vercel Cron（または GitHub Actions）
- カード情報：Wizards 公式デッキリスト（一次情報）＋ MTGJSON（印刷仕様の補完・検証）

---

## 晴れる屋の価格取得について（重要）

晴れる屋には公開 API がなく、データ取得の許可や利用条件も確認できていません。robots.txt では検索結果のページ送り・並べ替えが禁止されており、全デッキ分を毎朝自動取得すると 1 日数千回規模のアクセスになります。そのため、**現在の既定は「CSV取込・手入力」で記録する運用**です。

| | 既定（CSV・手入力） | 自動取得（許可を得た場合のみ） |
|---|---|---|
| 晴れる屋へのアクセス | しない | 1カード1回の検索、3秒以上の間隔、1回300件まで |
| 毎朝 6:00 の処理 | 記録済みの価格でデッキ合計を集計・前日比を計算 | 価格取得 → 集計 |
| 価格の入れ方 | 価格取込画面で CSV（テンプレートあり）・管理画面で手入力 | 自動（失敗分は手入力・URL 紐づけで補完） |

価格取得部分は交換可能なアダプター（`src/lib/prices/types.ts` の `PriceAdapter`）です。晴れる屋の自動取得アダプター（`src/lib/prices/hareruya.ts`）は実装済みですが無効になっています。

### 自動取得を有効にする手順（許可を得たあとだけ）
1. 環境変数 `HARERUYA_AUTO_FETCH=enabled`
2. SQL: `update price_sources set fetch_mode = 'auto' where id = 'hareruya_buyback';`
3. 取得件数が多い場合は Vercel の実行時間（5分）に収まらないため、GitHub Actions の定期実行に切り替えます（下記）。

> 自動取得アダプターのページ解析は 2026 年 9 月時点で確認したページ構造に合わせています。有効化した際は、管理画面の「自動照合の一覧」で最初の結果を必ず確認してください。

---

## セットアップ

### 1. Supabase
1. Supabase でプロジェクトを作成（リージョンは Tokyo 推奨）
2. Project Settings → Database → Connection string → **Transaction pooler** の URI を控える
3. ローカルでマイグレーションを適用
   ```bash
   npm ci
   cp .env.example .env.local   # DATABASE_URL などを記入
   DATABASE_URL="(上のURI)" npm run db:migrate
   ```
   Supabase CLI を使う場合は `supabase db push` でも `supabase/migrations/` が適用されます。

### 2. Vercel
1. GitHub リポジトリを Vercel に Import
2. Environment Variables に `DATABASE_URL`・`CRON_SECRET`（ランダムな文字列）・必要なら `APP_BASIC_AUTH` を設定
3. デプロイすると `vercel.json` の Cron（`0 21 * * *` = 日本時間 6:00）が有効になります
   - Vercel の Cron は UTC 指定です。Hobby プランでは実行時刻が最大 1 時間程度ずれることがあります。時刻を厳密にしたい場合は Pro プランか GitHub Actions を使ってください。

### 3. （任意）GitHub Actions で定期実行する
`.github/workflows/daily.yml` を同梱しています。リポジトリの Settings で
- Secrets: `DATABASE_URL`
- Variables: `USE_GITHUB_ACTIONS_CRON=true`（自動取得を使うなら `HARERUYA_AUTO_FETCH=enabled` も）

を設定すると毎朝 6:00 に `npm run job:daily` が動きます。Vercel Cron と二重に動かさないよう、使う場合は `vercel.json` の `crons` を削除してください（同時に動いてもジョブは二重実行防止で片方がスキップされます）。

### 4. 最初の使い方
1. 「デッキ検索・登録」→「一覧を更新」で MTGJSON のデッキ一覧を取得
2. 公式デッキリストの URL（例: `https://magic.wizards.com/en/news/announcements/edge-of-eternities-commander-decklists`）を入れて「内容を確認」→ 日本語版／英語版を選んで登録
3. 「価格取込」→ 入力用 CSV をダウンロードし、買取価格を記入して取り込む
4. 翌日も同様に取り込むと、ダッシュボードとデッキ詳細に前日比が出ます

---

## 毎日の運用

| いつ | 何をする | どこで |
|---|---|---|
| 毎朝 6:00 | 自動：デッキ合計の集計、前日比の計算、公式リストの変更チェック（7日ごとに数件ずつ） | — |
| 価格を更新したいとき | 「今日まだ価格が無いカード」の CSV を出力 → 記入 → 取込 | 価格取込 |
| 適宜 | 未取得カード・確認待ちカード・大きく変動した価格の確認 | 管理 |

CSV 取込・手入力は取り込んだ時点で今日の合計を再計算します。

---

## 画面

| 画面 | パス | 内容 |
|---|---|---|
| ダッシュボード | `/` | 登録デッキ数、更新状況、未取得カード数、合計ランキング、前日比の上昇・下落、デッキ一覧（表／カード切替） |
| デッキ検索・登録 | `/decks/search` | 公式URLからの取り込み（確認画面つき）、MTGJSON 一覧の検索（名前・セット・発売年・製品カテゴリ）と一括登録、CSV 手動登録。登録済みは表示で区別 |
| デッキ詳細 | `/decks/[id]` | 合計（または小計＋未取得数）、前日比・7日前比・30日前比、最高・最低記録、取得成功率、カード一覧（並べ替え・検索・未取得のみ・晴れる屋リンク）、CSVエクスポート、公式リストとの照合 |
| 価格推移 | `/decks/[id]/history` | 合計の折れ線グラフ（7日／30日／90日／全期間）、値動きの大きいカード、カード単体の推移 |
| 価格取込 | `/prices/import` | 入力用 CSV のダウンロード、CSV 取込、取込結果 |
| 管理 | `/admin` | 定期更新の状況、手動更新、未取得カード（理由別）、手入力・商品URL紐づけ・誤照合の解除、印刷仕様の確定、異常値、更新履歴、設定 |

---

## データの扱い（仕様上の約束ごと）

- **別版の価格を採用しない**：照合はセット・番号・言語・仕様の完全一致 → 番号が載っていない候補が一意 → 複数なら手動確認 → 無ければ失敗、の順。名前だけ一致した価格は使いません（`src/lib/prices/match.ts`）。
- **失敗は 0 円にしない**：失敗は `price_jpy = null` と理由（検索結果なし／複数候補／アクセスエラー／解析失敗／価格非公開／照合確認待ち）で記録します。
- **最終成功価格と今回の結果を区別**：`price_latest` ビューに両方あります。同じ日の成功記録は、後からの失敗で上書きしません。
- **履歴は 1 日 1 件**：`price_history (source_id, printing_id, observed_date)` が一意。同じ日の再取得は上書きです。
- **未取得があるデッキは「小計」**：合計欄は「取得済みカードの小計」と「未取得 n 種類」を表示し、前日比には「参考」をつけます。最高・最低記録は全カードが揃った日だけを対象にします。
- **価格の有効日数**（既定 7 日）より古い成功価格は合計に使いません（画面では最終成功価格として表示）。
- **基本土地**は既定で合計に含めません（管理画面で「価格があれば含める」に変更可）。
- **異常値**：前回の成功価格から既定 50% 超動いた価格（300 円未満は対象外）に印をつけます。
- **デッキの重複登録防止**：同じ取り込み元キー、または同じ MTGJSON デッキ × 同じ言語は登録できません。
- **公式リストの変更検知**：保存済みの構成と比べ、差分があれば記録して確認待ちにします（自動では書き換えません）。

## 実装上の仮定（確認できていない点）

1. **公式ページの構造**：Wizards の記事内の `<deck-list deck-title="…" format="commander">` と `<main-deck>` / `<side-board>` を読みます。統率者デッキの `<side-board>` を統率者とみなしますが、MTGJSON の統率者情報と一致しない場合は確認待ちにします。ページ構造が違って読めない場合はエラーにし、MTGJSON 登録か CSV 登録を案内します。mtg-jp.com のページは URL として受け付けますが、同じ構造でない場合は読めません。
2. **公式ページには印刷仕様が載っていない**ため、セット記号・コレクター番号・Foil 仕様は同名の MTGJSON デッキで補完します。公式と MTGJSON で枚数や名前が食い違うカードは確認待ちです。
3. **日本語版デッキ**は英語版と同じセット記号・コレクター番号・仕様であると仮定し、言語だけを `ja` にしています。デッキは言語ごとに別登録です。
4. **カード画像**は Scryfall の ID から画像 URL を組み立てています（API 呼び出しなし）。日本語名は MTGJSON の日本語データです。
5. **前日比**は前日のスナップショット、無ければ 3 日前までで最も近い日と比べます（比較日は画面のツールチップに表示）。
6. **カード一覧の「前日比」**は小計ベース（単価差 × 枚数）です。ツールチップに前日単価を表示します。
7. **アクセス制限**は簡易な Basic 認証です（`APP_BASIC_AUTH`）。スタッフごとのログインが必要なら Supabase Auth を追加してください。

---

## CSV の形式

### 買取価格 CSV（価格取込）
```
カード名,セット,番号,言語,仕様,買取価格,URL,取得日時
Sol Ring,EOC,57,JP,nonfoil,300,,2026-11-09 10:00
"Hearthhull, the Worldseed",EOC,1,JP,foil,1500,https://www.hareruyamtg.com/ja/purchase/...,
```
- 必須：カード名・セット・言語（JP / EN）・仕様（nonfoil / foil / etched）
- 番号は推奨。無い場合は登録済みの版から一意に決まるときだけ採用
- 買取価格：数値（`¥`・`,` 可）／ `-` は価格非公開／空欄は読み飛ばし
- URL を入れると、そのカード版と晴れる屋の商品が「確認済み」として紐づきます
- 取得日時は省略すると取込時刻。日本時間として扱います

### デッキ CSV（手動登録）
```
枚数,カード名,セット,番号,仕様,区分,日本語名
1,"Hearthhull, the Worldseed",EOC,1,foil,統率者,
1,Sol Ring,EOC,57,nonfoil,メイン,
```
区分：統率者 / メイン / トークン / ディスプレイ / その他（トークン以下は枚数合計に含めません）。

---

## データベース

`supabase/migrations/20261109000000_init.sql`

| テーブル | 内容 |
|---|---|
| products | 製品（カテゴリ：統率者／チャレンジャー／スターター／その他、セット、発売日） |
| decks | デッキ（言語、取り込み元、公式URL、想定枚数、検証結果、内容ハッシュ、差分検知日時） |
| deck_revisions | 公式リストの確認履歴と差分 |
| deck_catalog | MTGJSON のデッキ一覧（検索用） |
| cards | カード共通情報（Oracle ID、英語名、日本語名） |
| card_printings | 印刷版（セット、番号、言語、仕様、特殊仕様、Scryfall ID） |
| deck_cards | デッキ構成（印刷版、枚数、区分、基本土地、確定状況） |
| price_sources | 価格の取得元（晴れる屋 買取。ほかのサイトは行を追加） |
| source_products | 取得元の商品 ID・URL とカード版の照合結果（`hareruya_products` ビューあり） |
| price_history | 価格履歴（1日1件、失敗は null＋理由、異常値フラグ） |
| deck_daily_totals | デッキ合計の日次スナップショット |
| update_jobs | 実行記録（二重実行防止の一意制約、ログ） |
| app_settings | 設定 |

---

## 開発・テスト

```bash
npm ci
npm run dev                 # http://localhost:3000
npm run lint                # 型チェック
TEST_DATABASE_URL=postgres://... npm test
```

- テストは `TEST_DATABASE_URL` のデータベースを毎回作り直します。`DATABASE_URL` と同じ値だとテストは実行されません（本番とテストの分離）。
- 外部サイトへのアクセスはテストでは差し替えています（`tests/fixtures/sample.ts` は形式を模した架空データ）。
- `tests/flow.test.ts` は指示書の実証項目（公式デッキの取得 → 保存 → 印刷仕様の識別 → 価格取込 → 合計 → 翌日の前日比）、定期処理の再試行・失敗の扱い・二重実行防止・変更検知を通しで確認します。
- 画面確認用のデモデータ：`DATABASE_URL=<確認用DB> npx tsx scripts/seed-demo.ts --yes`

### ファイル構成
```
src/app/                 画面とAPI（/api/cron/daily, /api/decks/[id]/csv, /api/prices/template）
src/app/actions.ts       画面の操作（登録・取込・手入力・紐づけ・設定）
src/lib/decks/           公式ページ解析、MTGJSON、CSV、検証、保存、変更検知
src/lib/prices/          照合、晴れる屋アダプター、価格記録、CSV取込、集計
src/lib/jobs/            定期処理、ジョブ管理（二重実行防止）
supabase/migrations/     マイグレーション
scripts/                 マイグレーション、定期処理（CLI）、デモデータ
tests/                   単体テスト・通しテスト
```

## 今後の拡張の目安
- 販売価格の追跡：`price_sources` に `hareruya_sell`（price_kind = 'sell'）を追加
- ほかの買取サイト：`PriceAdapter` を実装し `activeAdapter()` に登録
- チャレンジャーデッキ等：検索画面のカテゴリ切替で登録可能（想定枚数は MTGJSON の種別から 100 / 60 を設定、CSV では任意の枚数）
