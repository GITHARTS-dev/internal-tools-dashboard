import { Hono } from 'hono';
import type { Env } from '../context';
import { actor, db, patchFrom, zodErrorResponse } from '../context';
import {
  internalProductCreateSchema,
  internalProductUpdateSchema,
} from '../../shared/schema';
import {
  createInternalProduct,
  deleteInternalProduct,
  getInternalProduct,
  listInternalProducts,
  toolCountsByProduct,
  updateInternalProduct,
} from '../repo/internalProducts';
import { listTools } from '../repo/tools';
import { recordAudit } from '../repo/audit';
import { computeCeoSummary } from '../../shared/ceo';
import { rateTablesByMonth } from '../repo/fxRates';
import { getSettings } from '../repo/settings';
import { listAllTools } from '../repo/tools';
import { listPayments } from '../repo/payments';
import { todayInTimezone } from '../../shared/dates';

export const internalProductRoutes = new Hono<{ Bindings: Env }>();

internalProductRoutes.get('/internal-products', async (c) => {
  const [products, counts] = await Promise.all([
    listInternalProducts(db(c)),
    toolCountsByProduct(db(c)),
  ]);
  return c.json({
    products: products.map((p) => ({ ...p, tool_count: counts[p.id] ?? 0 })),
  });
});

internalProductRoutes.get('/internal-products/:id', async (c) => {
  const product = await getInternalProduct(db(c), c.req.param('id'));
  if (!product) {
    return c.json({ error: 'not_found', message: 'No internal product with that id.' }, 404);
  }
  // The tools that make up its running cost, including archived ones so the
  // history of what it used to cost stays visible.
  const tools = await listTools(db(c), { internalProductId: product.id, includeArchived: true });
  return c.json({ product, tools });
});

internalProductRoutes.post('/internal-products', async (c) => {
  const parsed = internalProductCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const product = await createInternalProduct(db(c), parsed.data);
  await recordAudit(db(c), {
    entity: 'internal_product',
    entity_id: product.id,
    action: 'create',
    actor: actor(c),
    summary: `Added internal product ${product.name}`,
  });
  return c.json({ product }, 201);
});

internalProductRoutes.patch('/internal-products/:id', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = internalProductUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const patch = patchFrom(raw, parsed.data);
  const product = await updateInternalProduct(db(c), c.req.param('id'), patch);
  if (!product) {
    return c.json({ error: 'not_found', message: 'No internal product with that id.' }, 404);
  }

  await recordAudit(db(c), {
    entity: 'internal_product',
    entity_id: product.id,
    action: 'update',
    actor: actor(c),
    summary: `Updated ${Object.keys(patch).join(', ') || 'nothing'} on ${product.name}`,
  });
  return c.json({ product });
});

/**
 * Remove a product. The tools attributed to it are kept and become
 * unattributed, because we are still paying for them.
 */
internalProductRoutes.delete('/internal-products/:id', async (c) => {
  const id = c.req.param('id');
  const product = await getInternalProduct(db(c), id);
  if (!product) {
    return c.json({ error: 'not_found', message: 'No internal product with that id.' }, 404);
  }

  const counts = await toolCountsByProduct(db(c));
  await deleteInternalProduct(db(c), id);
  await recordAudit(db(c), {
    entity: 'internal_product',
    entity_id: id,
    action: 'delete',
    actor: actor(c),
    summary: `Removed internal product ${product.name}; ${counts[id] ?? 0} tool(s) kept, now unattributed`,
  });
  return c.json({ deleted: true, tools_released: counts[id] ?? 0 });
});

/**
 * The CEO summary. One currency, with every assumption it rests on returned
 * alongside the numbers so the screen can state them.
 */
internalProductRoutes.get('/ceo-summary', async (c) => {
  const settings = await getSettings(db(c));
  const [tools, payments, products, tables] = await Promise.all([
    listAllTools(db(c)),
    listPayments(db(c)),
    listInternalProducts(db(c)),
    rateTablesByMonth(db(c)),
  ]);

  return c.json(
    computeCeoSummary({
      tools,
      payments,
      products,
      tables,
      reportingCurrency: settings.reporting_currency,
      today: todayInTimezone(settings.timezone),
    }),
  );
});
