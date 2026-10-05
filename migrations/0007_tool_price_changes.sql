-- A tool's price, over time.
--
-- `tools.cost_amount` is the price today -- what the dashboard's run-rate uses.
-- Vendors change prices, though, and the change has a start date: "Claude goes
-- from $20 to $22 from November". Each row here is one such change. A payment
-- is billed at the price in effect on its due date, so bills from that date use
-- the new price until the next change, and nothing before it moves. Paid
-- payments keep what was actually paid; this table never rewrites them.
--
-- `previous_amount` is the price in effect just before the change, as it stood
-- when the change was recorded. It is what a bill dated before the first
-- recorded change is priced at, and what the price history shows as "was".
--
-- One change per tool per start date: entering the same date again corrects
-- it rather than stacking a second row.

CREATE TABLE tool_price_changes (
  id                TEXT PRIMARY KEY,
  tool_id           TEXT NOT NULL REFERENCES tools (id) ON DELETE CASCADE,
  effective_from    TEXT NOT NULL,                -- 'YYYY-MM-DD'
  amount            INTEGER NOT NULL CHECK (amount >= 0),
  currency          TEXT NOT NULL,
  previous_amount   INTEGER,
  previous_currency TEXT,
  note              TEXT,
  changed_by        TEXT,
  created_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_price_changes_key ON tool_price_changes (tool_id, effective_from);
