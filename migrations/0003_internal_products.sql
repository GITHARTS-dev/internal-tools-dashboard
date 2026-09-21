-- The company's own products, and what it costs to keep them running.
--
-- Deliberately NOT a second ledger. A hosting bill or a domain renewal is a
-- thing we pay a vendor for, which is exactly what `tools` already models --
-- with payments, alerts, renewal dates and notice deadlines already working on
-- it. So an internal product is just a bucket that tools can be attributed to,
-- and its running cost is the roll-up of its attributed tools.
--
-- The consequence worth stating: adding an internal product costs nothing in
-- new alerting or ledger code, and a hosting renewal chases the owner through
-- the same reminder path as a Canva renewal.
--
-- Scope decision (confirmed, see PRODUCT.md): running cost is subscription and
-- licence cash only. Staff time is explicitly out -- there is nowhere in this
-- schema to record it, on purpose.

CREATE TABLE internal_products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'live'
                CHECK (status IN ('live', 'building', 'retired')),
  owner_name  TEXT,
  owner_email TEXT,
  launched_on TEXT,
  retired_on  TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_internal_products_status ON internal_products (status);

-- ON DELETE SET NULL, not CASCADE: retiring a product must never delete the
-- hosting bill we are still paying, nor the payment history proving we paid it.
ALTER TABLE tools
  ADD COLUMN internal_product_id TEXT REFERENCES internal_products (id) ON DELETE SET NULL;

CREATE INDEX idx_tools_internal_product ON tools (internal_product_id);
