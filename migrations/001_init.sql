CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  check_every_hours INTEGER NOT NULL DEFAULT 24,
  status TEXT NOT NULL DEFAULT 'queued',
  paused_from_status TEXT,
  last_change_at TEXT,
  last_check_at TEXT,
  last_error TEXT,
  baseline_snapshot_json TEXT,
  last_snapshot_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  run_id TEXT,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  target_url TEXT NOT NULL,
  type TEXT NOT NULL,
  acknowledged_at TEXT,
  last_seen_at TEXT,
  repeat_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_label TEXT NOT NULL,
  target_url TEXT NOT NULL,
  diff_json TEXT,
  snapshot_fingerprint TEXT,
  error TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_targets_active ON targets(active);
CREATE INDEX IF NOT EXISTS idx_targets_last_check_at ON targets(last_check_at);
CREATE INDEX IF NOT EXISTS idx_alerts_target_status ON alerts(target_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_target_started_at ON runs(target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);
