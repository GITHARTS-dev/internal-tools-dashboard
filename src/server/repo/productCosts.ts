import { nowIso, uuid, type Db } from './db';
import type { ProductCost } from '../../shared/types';
import type { ProductCostInput } from '../../shared/schema';

/**
 * Monthly costs recorded against our own products.
 *
 * Writes are an upsert keyed on (product, month, provider) with the provider
 * compared case-insensitively, so typing "aws" for a month that already has
 * "AWS" replaces that line instead of adding a second one. That is done as an
 * explicit look-up rather than ON CONFLICT: the unique index is on
 * LOWER(provider), and the syntax for naming an expression as a conflict target
 * differs between SQLite and Postgres, which is exactly the kind of thing this
 * layer exists to keep out of the two engines' way.
 */

type Row = Record<string, unknown>;

const COLUMNS =
  'id, product_id, month, provider, amount, currency, source, note, created_at, updated_at';

function mapCost(row: Row): ProductCost {
  return {
    ...row,
    // node-postgres returns INTEGER as a number, but be explicit: a cost that
    // arrived as a string would concatenate instead of adding.
    amount: Number(row['amount']),
  } as ProductCost;
}

/** Newest month first, then provider, so the table reads top to bottom in time. */
export async function listProductCosts(db: Db, productId: string): Promise<ProductCost[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM product_costs WHERE product_id = ?
       ORDER BY month DESC, LOWER(provider)`,
    )
    .bind(productId)
    .all<Row>();
  return results.map(mapCost);
}

/** Every product's costs, for the roll-up on the dashboard. */
export async function listAllProductCosts(db: Db): Promise<ProductCost[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM product_costs ORDER BY month DESC`)
    .all<Row>();
  return results.map(mapCost);
}

export async function getProductCost(db: Db, id: string): Promise<ProductCost | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM product_costs WHERE id = ?`)
    .bind(id)
    .first<Row>();
  return row ? mapCost(row) : null;
}

export async function countProductCosts(db: Db, productId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM product_costs WHERE product_id = ?')
    .bind(productId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Every currency a cost has been recorded in, so exchange rates get fetched for it. */
export async function distinctCostCurrencies(db: Db): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT DISTINCT currency FROM product_costs')
    .all<{ currency: string }>();
  return results.map((r) => r.currency.toUpperCase());
}

export interface UpsertResult {
  cost: ProductCost;
  /** False when an existing line for that month and provider was replaced. */
  created: boolean;
}

/** The line for one product, month and provider, compared case-insensitively. */
export async function findProductCost(
  db: Db,
  productId: string,
  month: string,
  provider: string,
): Promise<ProductCost | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM product_costs
       WHERE product_id = ? AND month = ? AND LOWER(provider) = LOWER(?)`,
    )
    .bind(productId, month, provider)
    .first<Row>();
  return row ? mapCost(row) : null;
}

/** Whether any line for this month was imported rather than typed. */
export async function hasImportedCosts(db: Db, month: string, source: ProductCost['source']): Promise<boolean> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM product_costs WHERE month = ? AND source = ?')
    .bind(month, source)
    .first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

/**
 * `source` says who wrote the figure. Anything entered through the product page
 * is 'manual', including a correction to an imported line: once a person has
 * overridden what AWS said, the next import leaves it alone.
 */
export async function upsertProductCost(
  db: Db,
  productId: string,
  input: ProductCostInput,
  source: ProductCost['source'] = 'manual',
): Promise<UpsertResult> {
  const ts = nowIso();

  const existing = await findProductCost(db, productId, input.month, input.provider);

  if (existing) {
    // The provider is rewritten too, so a correction to its spelling or case
    // ("aws" -> "AWS") is kept rather than the old form living on.
    await db
      .prepare(
        `UPDATE product_costs
            SET provider = ?, amount = ?, currency = ?, note = ?, source = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(input.provider, input.amount, input.currency, input.note ?? null, source, ts, existing.id)
      .run();
    const cost = await getProductCost(db, existing.id);
    if (!cost) throw new Error('Cost vanished immediately after update');
    return { cost, created: false };
  }

  const id = uuid();
  await db
    .prepare(
      `INSERT INTO product_costs
         (id, product_id, month, provider, amount, currency, source, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, productId, input.month, input.provider, input.amount, input.currency, source, input.note ?? null, ts, ts)
    .run();

  const cost = await getProductCost(db, id);
  if (!cost) throw new Error('Cost vanished immediately after insert');
  return { cost, created: true };
}

export async function deleteProductCost(db: Db, id: string): Promise<void> {
  await db.prepare('DELETE FROM product_costs WHERE id = ?').bind(id).run();
}
