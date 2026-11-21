-- MEEHOA Order Bot V1 (Cloudflare D1 Migration)
-- Target Database: meehoasg-ops-staging (16bf0134-64c6-43ea-8098-b40c95251667)
-- Safety: Completely isolated tables, no modification of orders, app_users, or existing OPS data.

-- Table 1: Persistent bot drafts and per-user locking
CREATE TABLE IF NOT EXISTS bot_drafts (
  user_id INTEGER PRIMARY KEY,
  active_draft_id TEXT,
  drafts_json TEXT NOT NULL,
  lock_acquired_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Table 2: Deduplication of Telegram updates
CREATE TABLE IF NOT EXISTS bot_processed_updates (
  update_id INTEGER PRIMARY KEY,
  user_id INTEGER,
  processed_at TEXT DEFAULT (datetime('now'))
);

-- Table 3: Audit log of bot operations and OPS integration receipts
CREATE TABLE IF NOT EXISTS bot_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  draft_id TEXT,
  request_id TEXT,
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_drafts_updated ON bot_drafts(updated_at);
CREATE INDEX IF NOT EXISTS idx_bot_updates_user ON bot_processed_updates(user_id);
