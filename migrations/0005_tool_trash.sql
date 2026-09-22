-- Deleting a tool puts it in the trash instead of removing the row.
--
-- Archiving (`status = 'cancelled'`) is for a subscription that genuinely
-- ended -- its payment history stays on the record forever, by design. A
-- delete is different: it is for a row that should never have existed at all
-- (a test entry, a duplicate, a mistake), and until now the only way to get
-- rid of one was a hard DELETE with no way back.
--
-- `deleted_at` marks a tool as trashed; `deleted_by` records who did it, for
-- the same reason every other change here is attributed. Every query that
-- lists tools excludes trashed rows by default (see listTools), so a trashed
-- tool behaves as gone everywhere -- the dashboard, alerts, spend totals,
-- History -- while the row itself, and its payments, are still sitting there
-- to restore. A trashed row is purged for real once it has sat long enough
-- that nobody is coming back for it (see purgeTrash).

ALTER TABLE tools ADD COLUMN deleted_at TEXT;
ALTER TABLE tools ADD COLUMN deleted_by TEXT;

CREATE INDEX idx_tools_deleted_at ON tools (deleted_at);
