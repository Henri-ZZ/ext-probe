-- Neon PostgreSQL 初始化结构。可重复执行。

CREATE TABLE IF NOT EXISTS collection_batches (
  id uuid PRIMARY KEY,
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  source text NOT NULL,
  shard_index integer NOT NULL DEFAULT 0 CHECK (shard_index >= 0),
  shard_count integer NOT NULL DEFAULT 1 CHECK (shard_count > 0),
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_message text
);

-- 兼容在分片功能加入前已经初始化过的数据库。
ALTER TABLE collection_batches
  ADD COLUMN IF NOT EXISTS shard_index integer NOT NULL DEFAULT 0;

ALTER TABLE collection_batches
  ADD COLUMN IF NOT EXISTS shard_count integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS ranking_runs (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES collection_batches(id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL,
  keyword text NOT NULL,
  locale text NOT NULL,
  target_extension_id text NOT NULL,
  target_rank integer,
  not_found_within integer,
  requested_top_n integer NOT NULL,
  collected_count integer NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  duration_ms integer NOT NULL,
  collection_mode text NOT NULL,
  loaded_batches integer NOT NULL DEFAULT 0,
  end_of_results boolean NOT NULL DEFAULT false,
  diagnostics jsonb,
  error_message text,
  CONSTRAINT ranking_runs_target_rank_positive CHECK (target_rank IS NULL OR target_rank > 0),
  CONSTRAINT ranking_runs_counts_nonnegative CHECK (requested_top_n > 0 AND collected_count >= 0)
);

CREATE TABLE IF NOT EXISTS ranking_results (
  run_id uuid NOT NULL REFERENCES ranking_runs(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position > 0),
  extension_id text NOT NULL,
  PRIMARY KEY (run_id, position),
  UNIQUE (run_id, extension_id)
);

CREATE INDEX IF NOT EXISTS ranking_runs_keyword_locale_time_idx
  ON ranking_runs (keyword, locale, collected_at DESC);

CREATE INDEX IF NOT EXISTS ranking_results_extension_idx
  ON ranking_results (extension_id, run_id);

CREATE INDEX IF NOT EXISTS collection_batches_scheduled_at_idx
  ON collection_batches (scheduled_at DESC);

-- 每个 (keyword, locale) 组的采集健康状态，由本仓库独占写入。
--
-- 存在的理由：失败的任务没有成功的 ranking_runs 记录，因此在「最久未采集优先」的
-- 调度里会永远排在最前面。没有这张表时，若干个持续失败的组合就能把每一批名额占满，
-- 导致其他正常目标永远排不上队（静默停更）。
CREATE TABLE IF NOT EXISTS collection_state (
  keyword text NOT NULL,
  locale text NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  -- 退避到期时间。到期前该组不再参与调度。
  next_attempt_at timestamptz,
  last_error text,
  last_failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, locale)
);

CREATE INDEX IF NOT EXISTS collection_state_retry_idx
  ON collection_state (next_attempt_at);

-- 扩展的商店元数据（标题、图标等）。
--
-- 由 ext-probe 独占写入：所有 Chrome Web Store 出网请求都留在本仓库。
-- ext-signal 只读取这张表来展示名称与图标，不会写入。
--
-- 两个数据来源：
--   1. 搜索结果页内嵌的 AF_initDataCallback 数据，随采集免费获得；
--   2. 详情页的 og: 元数据，由 POST /admin/resolve 按需抓取。
CREATE TABLE IF NOT EXISTS extension_profiles (
  cws_id text PRIMARY KEY,
  title text NOT NULL,
  icon_url text,
  description text,
  slug text,
  rating double precision,
  rating_count integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
