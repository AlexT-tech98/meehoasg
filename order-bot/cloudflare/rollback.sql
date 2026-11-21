-- MEEHOA Order Bot V1 (Cloudflare D1 Rollback Script)
-- Reverts bot tables safely without impacting any core OPS data.

DROP INDEX IF EXISTS idx_bot_updates_user;
DROP INDEX IF EXISTS idx_bot_drafts_updated;
DROP TABLE IF EXISTS bot_audit_logs;
DROP TABLE IF EXISTS bot_processed_updates;
DROP TABLE IF EXISTS bot_drafts;
