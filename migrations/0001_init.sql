-- Internal Tools & Subscriptions Dashboard :: initial schema
--
-- Conventions used throughout:
--   * money  -> INTEGER in minor units (paise/cents) + an explicit currency code.
--               Never floats: 0.1 + 0.2 must not decide whether a bill is paid.
--   * dates  -> TEXT 'YYYY-MM-DD'   (calendar days; no time component)
--   * stamps -> TEXT ISO-8601 UTC   (created_at / updated_at)
--   * ids    -> TEXT uuid
--
-- "overdue" is deliberately NOT a stored payment status. It is derived from
-- due_date vs today in src/shared/alerts.ts so the stored row can never drift
-- out of sync with what the dashboard and the reminder job believe.

CREATE TABLE tools (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  vendor                   TEXT,
  category                 TEXT NOT NULL DEFAULT 'other',
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'trial', 'cancelled', 'expired')),

  owner_name               TEXT,
  owner_email              TEXT,
  department               TEXT,

  billing_cycle            TEXT NOT NULL DEFAULT 'monthly'
                             CHECK (billing_cycle IN ('monthly', 'quarterly', 'annual', 'one_time', 'custom')),
  cost_amount              INTEGER,
  currency                 TEXT NOT NULL DEFAULT 'INR',

  seats_purchased          INTEGER,
  seats_used               INTEGER,

  renewal_date             TEXT,
  auto_renew               INTEGER NOT NULL DEFAULT 1 CHECK (auto_renew IN (0, 1)),
  cancellation_notice_days INTEGER NOT NULL DEFAULT 0 CHECK (cancellation_notice_days >= 0),

  account_ref              TEXT,
  billing_email            TEXT,
  payment_method           TEXT,
  vendor_url               TEXT,
  notes                    TEXT,

  started_on               TEXT,
  cancelled_on             TEXT,

  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);

CREATE INDEX idx_tools_status       ON tools (status);
CREATE INDEX idx_tools_renewal      ON tools (renewal_date);
CREATE INDEX idx_tools_owner_email  ON tools (owner_email);
CREATE INDEX idx_tools_category     ON tools (category);

-- The ledger. Rows are never deleted, including for cancelled tools: this is
-- how "what did we pay Canva last year" stays answerable forever.
CREATE TABLE payments (
  id           TEXT PRIMARY KEY,
  tool_id      TEXT NOT NULL REFERENCES tools (id) ON DELETE CASCADE,
  period_start TEXT,
  period_end   TEXT,
  due_date     TEXT NOT NULL,
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'due'
                 CHECK (status IN ('due', 'paid', 'waived')),
  paid_on      TEXT,
  paid_by      TEXT,
  invoice_ref  TEXT,
  invoice_url  TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_payments_tool   ON payments (tool_id);
CREATE INDEX idx_payments_due    ON payments (due_date);
CREATE INDEX idx_payments_status ON payments (status);

-- Behind the FEATURE_DOCUMENTS flag (default off) until it is decided whether
-- invoices get stored at all, or only their amounts.
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  tool_id      TEXT NOT NULL REFERENCES tools (id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'other'
                 CHECK (kind IN ('contract', 'invoice', 'receipt', 'other')),
  title        TEXT NOT NULL,
  external_url TEXT,
  file_key     TEXT,
  uploaded_by  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_documents_tool ON documents (tool_id);

-- What has actually been sent. The UNIQUE dedupe_key is the only thing
-- standing between us and spamming people the same reminder every morning.
CREATE TABLE notification_log (
  id          TEXT PRIMARY KEY,
  dedupe_key  TEXT NOT NULL UNIQUE,
  tool_id     TEXT REFERENCES tools (id) ON DELETE CASCADE,
  payment_id  TEXT REFERENCES payments (id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,
  channel     TEXT NOT NULL,
  target      TEXT,
  severity    TEXT,
  status      TEXT NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'failed', 'skipped')),
  detail      TEXT,
  sent_at     TEXT NOT NULL
);

CREATE INDEX idx_notif_tool ON notification_log (tool_id);
CREATE INDEX idx_notif_sent ON notification_log (sent_at);

-- Every mutation lands here, so "who changed Canva's renewal date, and when"
-- always has an answer. Together with `payments` this is the historical ledger.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'archive', 'delete', 'restore')),
  actor      TEXT NOT NULL DEFAULT 'system',
  summary    TEXT,
  diff_json  TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log (entity, entity_id);
CREATE INDEX idx_audit_created ON audit_log (created_at);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO settings (key, value, updated_at) VALUES
  ('timezone',             'Asia/Kolkata',              '2026-01-01T00:00:00.000Z'),
  ('default_currency',     'INR',                       '2026-01-01T00:00:00.000Z'),
  ('renewal_lead_days',    '[60,30,14,7,3,1]',          '2026-01-01T00:00:00.000Z'),
  ('payment_lead_days',    '[7,3,1]',                   '2026-01-01T00:00:00.000Z'),
  ('notice_lead_days',     '[14,7,3,1]',                '2026-01-01T00:00:00.000Z'),
  ('seat_underuse_ratio',  '0.7',                       '2026-01-01T00:00:00.000Z'),
  ('digest_weekday',       '1',                         '2026-01-01T00:00:00.000Z'),
  ('digest_horizon_days',  '45',                        '2026-01-01T00:00:00.000Z'),
  ('teams_webhook_url',    '',                          '2026-01-01T00:00:00.000Z'),
  ('email_from',           '',                          '2026-01-01T00:00:00.000Z'),
  ('email_to',             '',                          '2026-01-01T00:00:00.000Z');
