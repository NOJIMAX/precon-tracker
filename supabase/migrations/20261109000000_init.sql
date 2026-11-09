-- MTG構築済みデッキ 買取価格トラッカー 初期スキーマ
-- Supabase（PostgreSQL 15+）想定。`supabase db push` またはアプリ同梱の `npm run db:migrate` で適用できます。

create extension if not exists pgcrypto;

-- ───────────────────────── 設定 ─────────────────────────
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

insert into app_settings (key, value) values
  -- 基本土地の扱い: exclude = 常に除外 / include_if_priced = 価格があれば含める
  ('basic_land_policy', '"exclude"'),
  -- 最終成功価格を合計に使う最大日数（これより古い価格は「未取得」扱い）
  ('price_max_age_days', '7'),
  -- 前回比でこの割合（%）を超えて動いた価格は異常値として要確認にする
  ('anomaly_threshold_pct', '50'),
  -- 異常値判定の下限額（これ未満の単価は判定しない）
  ('anomaly_min_price_jpy', '300');

-- ───────────────────────── 製品・デッキ ─────────────────────────
create table products (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  name_ja       text,
  category      text not null default 'commander'
                  check (category in ('commander','challenger','starter','other')),
  set_code      text,
  set_name      text,
  release_date  date,
  official_url  text,
  created_at    timestamptz not null default now(),
  unique (name, set_code)
);

-- MTGJSON DeckList を保存した検索用カタログ（未登録デッキの検索・絞り込み用）
create table deck_catalog (
  file_name     text primary key,          -- MTGJSON のデッキファイル名（一意キー）
  name          text not null,
  set_code      text not null,
  deck_type     text not null,             -- 'Commander Deck' など MTGJSON の type
  release_date  date,
  fetched_at    timestamptz not null default now()
);
create index deck_catalog_name_idx on deck_catalog using btree (lower(name));

create table decks (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid references products(id) on delete set null,
  name                text not null,
  name_ja             text,
  language            text not null check (language in ('ja','en')),
  -- 取り込み元: wizards = 公式ページ / mtgjson / csv = 手動
  source              text not null check (source in ('wizards','mtgjson','csv')),
  -- 重複登録防止キー（例: mtgjson:<fileName> / wizards:<url>#<deck-title> / csv:<hash>）
  source_key          text not null,
  official_url        text,
  mtgjson_file        text,
  set_code            text,
  release_date        date,
  expected_card_count integer not null default 100,
  commander_names     text[] not null default '{}',
  image_url           text,
  -- ok = 検証済み / needs_review = 確認待ちあり
  status              text not null default 'needs_review' check (status in ('ok','needs_review')),
  validation          jsonb not null default '{}'::jsonb,
  content_hash        text,
  last_checked_at     timestamptz,
  diff_detected_at    timestamptz,
  created_at          timestamptz not null default now(),
  unique (source_key, language)
);

-- 公式ページ等の内容変更の検知履歴
create table deck_revisions (
  id           bigserial primary key,
  deck_id      uuid not null references decks(id) on delete cascade,
  checked_at   timestamptz not null default now(),
  content_hash text not null,
  changed      boolean not null,
  diff         jsonb not null default '{}'::jsonb
);

-- ───────────────────────── カード ─────────────────────────
create table cards (
  id         uuid primary key default gen_random_uuid(),
  oracle_id  uuid unique,
  name_en    text not null,
  name_ja    text,
  created_at timestamptz not null default now()
);
create index cards_name_en_idx on cards (lower(name_en));

create table card_printings (
  id                uuid primary key default gen_random_uuid(),
  card_id           uuid not null references cards(id) on delete cascade,
  scryfall_id       uuid,
  set_code          text not null,
  collector_number  text not null,
  language          text not null check (language in ('ja','en')),
  finish            text not null check (finish in ('nonfoil','foil','etched')),
  -- 特殊仕様（ボーダーレス、ショーケース、拡張アート等）。不明なら null
  variant           text,
  image_url         text,
  created_at        timestamptz not null default now(),
  unique (set_code, collector_number, language, finish)
);

create table deck_cards (
  id                 uuid primary key default gen_random_uuid(),
  deck_id            uuid not null references decks(id) on delete cascade,
  line_no            integer not null,
  card_name          text not null,           -- デッキリスト上の表記
  printing_id        uuid references card_printings(id) on delete set null,
  quantity           integer not null check (quantity > 0),
  -- commander / main は合計枚数に含める。token / display / other は含めない
  section            text not null check (section in ('commander','main','token','display','other')),
  is_basic_land      boolean not null default false,
  resolution_status  text not null default 'needs_review' check (resolution_status in ('resolved','needs_review')),
  note               text,
  unique (deck_id, line_no)
);
create index deck_cards_printing_idx on deck_cards (printing_id);

-- ───────────────────────── 価格 ─────────────────────────
-- 価格の取得元。将来ほかの買取サイトを足すときは行を追加し、アダプターを実装する
create table price_sources (
  id          text primary key,
  name        text not null,
  price_kind  text not null check (price_kind in ('buyback','sell')),
  -- manual = CSV/手入力のみ / auto = 定期処理で自動取得
  fetch_mode  text not null default 'manual' check (fetch_mode in ('manual','auto')),
  base_url    text
);
insert into price_sources (id, name, price_kind, fetch_mode, base_url) values
  ('hareruya_buyback', '晴れる屋 買取', 'buyback', 'manual', 'https://www.hareruyamtg.com/ja/purchase/');

-- 取得元の商品（晴れる屋の商品IDやURL）とカード版の照合結果
create table source_products (
  id               uuid primary key default gen_random_uuid(),
  source_id        text not null references price_sources(id),
  printing_id      uuid not null references card_printings(id) on delete cascade,
  external_id      text,
  url              text,
  listed_name      text,
  listed_set_code  text,
  listed_number    text,
  listed_language  text,
  listed_finish    text,
  -- auto_exact = 完全一致 / auto_unique = 番号以外一致で一意 / confirmed = 手動確認済み / rejected = 誤照合として除外
  match_status     text not null check (match_status in ('auto_exact','auto_unique','confirmed','rejected')),
  matched_at       timestamptz not null default now(),
  note             text
);
-- 1つのカード版に有効な紐づけは1件だけ
create unique index source_products_active_uq
  on source_products (source_id, printing_id) where match_status <> 'rejected';

create view hareruya_products as
  select * from source_products where source_id = 'hareruya_buyback';

create table update_jobs (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('daily','manual','import','deck_check')),
  status         text not null default 'running' check (status in ('running','succeeded','partial','failed')),
  trigger        text,                      -- cron / button / api / cli
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  target_count   integer not null default 0,
  success_count  integer not null default 0,
  failure_count  integer not null default 0,
  retry_count    integer not null default 0,
  log            jsonb not null default '[]'::jsonb,
  error          text
);
-- 二重実行防止: 同じ種類の実行中ジョブは1件まで
create unique index update_jobs_one_running
  on update_jobs (kind) where status = 'running';

create table price_history (
  id                 bigserial primary key,
  source_id          text not null references price_sources(id),
  printing_id        uuid not null references card_printings(id) on delete cascade,
  source_product_id  uuid references source_products(id) on delete set null,
  -- 取得失敗時は null（0円として扱わない）
  price_jpy          integer check (price_jpy is null or price_jpy >= 0),
  status             text not null check (status in
                       ('ok','not_found','multiple_candidates','access_error','parse_error','not_listed','pending_review')),
  observed_at        timestamptz not null default now(),
  -- 日本時間の日付。同じ日の再取得は上書きし履歴を重複させない
  observed_date      date not null default (now() at time zone 'Asia/Tokyo')::date,
  method             text not null check (method in ('auto','csv','manual')),
  job_id             uuid references update_jobs(id) on delete set null,
  is_anomaly         boolean not null default false,
  previous_price_jpy integer,
  detail             text,
  -- 複数候補などのとき、手動確認用に候補を保存
  candidates         jsonb,
  constraint price_ok_has_price check (status <> 'ok' or price_jpy is not null),
  unique (source_id, printing_id, observed_date)
);
create index price_history_lookup_idx on price_history (source_id, printing_id, observed_date desc);

-- 最終成功価格と最新の取得結果を分けて参照するビュー
create view price_latest as
with last_ok as (
  select distinct on (source_id, printing_id)
         source_id, printing_id, price_jpy, observed_at, observed_date, method, is_anomaly
    from price_history where status = 'ok'
   order by source_id, printing_id, observed_date desc, observed_at desc
), last_try as (
  select distinct on (source_id, printing_id)
         source_id, printing_id, status, observed_at, detail
    from price_history
   order by source_id, printing_id, observed_date desc, observed_at desc
)
select t.source_id, t.printing_id,
       o.price_jpy      as last_ok_price_jpy,
       o.observed_at    as last_ok_at,
       o.observed_date  as last_ok_date,
       o.method         as last_ok_method,
       o.is_anomaly     as last_ok_is_anomaly,
       t.status         as last_status,
       t.observed_at    as last_attempt_at,
       t.detail         as last_detail
  from last_try t left join last_ok o using (source_id, printing_id);

-- デッキ合計の日次スナップショット（推移・前日比・最高/最低記録に使う）
create table deck_daily_totals (
  deck_id        uuid not null references decks(id) on delete cascade,
  source_id      text not null references price_sources(id),
  snapshot_date  date not null,
  total_jpy      integer not null,      -- 価格取得済みカードの小計
  priced_count   integer not null,      -- 価格ありの対象カード行数
  missing_count  integer not null,      -- 価格なしの対象カード行数
  target_count   integer not null,
  is_complete    boolean not null,      -- 対象カードがすべて価格ありのときだけ true
  computed_at    timestamptz not null default now(),
  primary key (deck_id, source_id, snapshot_date)
);
