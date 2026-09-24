-- Monthly costs for our own products.
--
-- A product's running cost is not the sum of its subscriptions' list prices.
-- Most of what it costs to run is usage-based cloud spend -- an AWS bill that is
-- different every month -- so it has to be recorded as what was actually spent,
-- month by month, not derived from a fixed price and a billing cycle.
--
-- One row per product, per month, per provider: `TRA · 2026-08 · AWS · $312`.
-- Provider is free text because a product can run on several (AWS, Supabase, a
-- domain registrar) and the breakdown is worth keeping, but it is unique
-- case-insensitively, so "aws" and "AWS" are the same line and re-entering a
-- month replaces it rather than duplicating it.
--
-- Money follows the rest of the schema: integer minor units plus an explicit
-- currency, converted at that month's rate when a combined figure is needed.
--
-- `source` is 'manual' today. It exists so a later automatic import can write
-- into this same table and be told apart from a figure a person typed, without
-- another migration.
--
-- ON DELETE RESTRICT, unlike the tools link: this is the ledger of what the
-- product cost, and "history is never lost" applies to it. A product with
-- recorded costs is retired, not deleted; the API refuses the delete and says so.

CREATE TABLE product_costs (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES internal_products (id) ON DELETE RESTRICT,
  month      TEXT NOT NULL,                       -- 'YYYY-MM'
  provider   TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount >= 0),
  currency   TEXT NOT NULL DEFAULT 'USD',
  source     TEXT NOT NULL DEFAULT 'manual'
               CHECK (source IN ('manual', 'aws')),
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_product_costs_key ON product_costs (product_id, month, LOWER(provider));
CREATE INDEX idx_product_costs_month ON product_costs (month);
