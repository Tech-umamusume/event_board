-- 阶段三切片 3.1.2：滴答直连的非破坏性增量表。
CREATE TABLE IF NOT EXISTS integration_configs (
  provider TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  target_project_id TEXT,
  target_project_name TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_syncs (
  event_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'dida',
  external_project_id TEXT,
  external_task_id TEXT,
  payload_hash TEXT,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('synced', 'skipped_no_time', 'failed', 'disabled')),
  last_error TEXT,
  synced_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, provider)
);
