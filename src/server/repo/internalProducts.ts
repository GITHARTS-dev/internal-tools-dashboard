import { buildUpdate, nowIso, uuid, type Db } from './db';
import type { InternalProduct } from '../../shared/types';
import type {
  InternalProductCreateInput,
  InternalProductUpdateInput,
} from '../../shared/schema';

const WRITABLE = [
  'name', 'description', 'status', 'owner_name', 'owner_email',
  'launched_on', 'retired_on', 'notes',
] as const;

type Row = Record<string, unknown>;

export async function listInternalProducts(db: Db): Promise<InternalProduct[]> {
  const { results } = await db
    .prepare('SELECT * FROM internal_products ORDER BY LOWER(name)')
    .all<Row>();
  return results as unknown as InternalProduct[];
}

export async function getInternalProduct(db: Db, id: string): Promise<InternalProduct | null> {
  const row = await db.prepare('SELECT * FROM internal_products WHERE id = ?').bind(id).first<Row>();
  return (row as unknown as InternalProduct) ?? null;
}

export async function createInternalProduct(
  db: Db,
  input: InternalProductCreateInput,
): Promise<InternalProduct> {
  const id = uuid();
  const ts = nowIso();
  const values = WRITABLE.map((col) => (input as Record<string, unknown>)[col] ?? null);

  await db
    .prepare(
      `INSERT INTO internal_products (id, ${WRITABLE.join(', ')}, created_at, updated_at)
       VALUES (?, ${WRITABLE.map(() => '?').join(', ')}, ?, ?)`,
    )
    .bind(id, ...values, ts, ts)
    .run();

  const created = await getInternalProduct(db, id);
  if (!created) throw new Error('Internal product vanished immediately after insert');
  return created;
}

export async function updateInternalProduct(
  db: Db,
  id: string,
  patch: InternalProductUpdateInput,
): Promise<InternalProduct | null> {
  const update = buildUpdate(patch as Record<string, unknown>, WRITABLE);
  if (update) {
    await db
      .prepare(`UPDATE internal_products SET ${update.clause}, updated_at = ? WHERE id = ?`)
      .bind(...update.values, nowIso(), id)
      .run();
  }
  return getInternalProduct(db, id);
}

/**
 * Delete the product, keeping every tool that was attributed to it.
 *
 * The foreign key is ON DELETE SET NULL, so the hosting bill survives its
 * product being removed -- it just stops being attributed. Deleting a product
 * is an admin correction, not a statement that the company stopped paying for
 * the things underneath it.
 */
export async function deleteInternalProduct(db: Db, id: string): Promise<void> {
  await db.prepare('DELETE FROM internal_products WHERE id = ?').bind(id).run();
}

/** How many tools point at each product, for list screens. */
export async function toolCountsByProduct(db: Db): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT internal_product_id AS id, COUNT(*) AS n
         FROM tools
        WHERE internal_product_id IS NOT NULL
        GROUP BY internal_product_id`,
    )
    .all<{ id: string; n: number }>();

  const out: Record<string, number> = {};
  for (const row of results) out[row.id] = row.n;
  return out;
}
