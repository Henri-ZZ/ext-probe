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
