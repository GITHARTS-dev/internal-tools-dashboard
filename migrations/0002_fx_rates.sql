-- Monthly FX reference rates, so cross-currency totals are possible without
-- making history unstable.
--
-- The rule the schema enforces by its primary key: one rate per currency per
-- month. A payment made in March 2026 is converted at March 2026's rate for
-- ever, so last year's total is the same number every time it is asked for.
--
-- Rates are ECB reference rates quoted against EUR (rate = units of `currency`
-- per 1 EUR). EUR is not stored: it is 1 by definition, and a row claiming
-- otherwise would be a bug waiting to be summed.
--
-- `rate` is TEXT holding a decimal string, not REAL. Same reason money is
-- INTEGER minor units: the moment a float enters the arithmetic, totals stop
-- being reproducible. src/shared/fx.ts parses this into a scaled BigInt.

CREATE TABLE fx_rates (
  month      TEXT NOT NULL,              -- 'YYYY-MM'
  currency   TEXT NOT NULL,              -- ISO 4217, uppercase
  rate       TEXT NOT NULL,              -- decimal string, units per 1 EUR
  source     TEXT NOT NULL DEFAULT 'ecb' -- 'ecb' | 'manual'
               CHECK (source IN ('ecb', 'manual')),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (month, currency)
);

CREATE INDEX idx_fx_month ON fx_rates (month);

-- The currency the CEO summary and any combined total is expressed in, plus
-- whether the daily job is allowed to reach the ECB on its own.
INSERT INTO settings (key, value, updated_at) VALUES
  ('reporting_currency', 'INR',  '2026-01-01T00:00:00.000Z'),
  ('fx_auto_refresh',    'true', '2026-01-01T00:00:00.000Z');
