import { Hono } from 'hono';
import type { Env } from '../context';
import { actor, db, patchFrom, zodErrorResponse } from '../context';
import {
  internalProductCreateSchema,
  internalProductUpdateSchema,
  productCostSchema,
} from '../../shared/schema';
import {
  countProductCosts,
  deleteProductCost,
  getProductCost,
  listAllProductCosts,
  listProductCosts,
  upsertProductCost,
} from '../repo/productCosts';
import { computeProductUsage } from '../../shared/productCosts';
import { formatMoney } from '../../shared/money';
import { monthOf } from '../../shared/fx';
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

  // The cost history is the ledger of what this product cost, and "history is
  // never lost" applies to it. A product that has recorded costs is retired, not
  // deleted. The constraint would refuse the delete anyway, but with a database
  // error rather than a way forward.
  const recorded = await countProductCosts(db(c), id);
  if (recorded > 0) {
    return c.json(
      {
        error: 'has_costs',
        message: `${product.name} has ${recorded} recorded monthly ${recorded === 1 ? 'cost' : 'costs'}, so it cannot be removed. Set its status to Retired instead; the history stays.`,
      },
      409,
    );
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

// ------------------------------------------------------------ monthly costs

/**
 * What a product has actually cost, month by month.
 *
 * Alongside the list comes the usage estimate the dashboard uses (the average
 * of the last three complete months, converted), so this screen can show the
 * same number and what it was averaged over, rather than recomputing it in the
 * browser with a different idea of which months count.
 */
internalProductRoutes.get('/internal-products/:id/costs', async (c) => {
  const id = c.req.param('id');
  const product = await getInternalProduct(db(c), id);
  if (!product) {
    return c.json({ error: 'not_found', message: 'No internal product with that id.' }, 404);
  }

  const settings = await getSettings(db(c));
  const [costs, tables] = await Promise.all([listProductCosts(db(c), id), rateTablesByMonth(db(c))]);

  return c.json({
    costs,
    reporting_currency: settings.reporting_currency,
    usage: computeProductUsage(costs, tables, settings.reporting_currency, todayInTimezone(settings.timezone)),
  });
});

/**
 * Record one month of one provider's cost.
 *
 * An upsert: entering a month and provider that already exist replaces that
 * line. That is what makes correcting a figure the same gesture as entering it,
 * and stops a second click producing a second row that would double the month.
 */
internalProductRoutes.post('/internal-products/:id/costs', async (c) => {
  const id = c.req.param('id');
  const product = await getInternalProduct(db(c), id);
  if (!product) {
    return c.json({ error: 'not_found', message: 'No internal product with that id.' }, 404);
  }

  const parsed = productCostSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  // A cost for a month that has not started is not a cost, it is a guess, and
  // would sit in the ledger looking like a fact.
  const settings = await getSettings(db(c));
  if (parsed.data.month > monthOf(todayInTimezone(settings.timezone))) {
    return c.json(
      {
        error: 'validation_failed',
        message: 'Some fields need fixing.',
        fields: { month: 'That month has not happened yet' },
      },
      400,
    );
  }

  const { cost, created } = await upsertProductCost(db(c), id, parsed.data);
  await recordAudit(db(c), {
    entity: 'product_cost',
    entity_id: cost.id,
    action: created ? 'create' : 'update',
    actor: actor(c),
    summary: `${created ? 'Recorded' : 'Replaced'} ${cost.provider} for ${product.name}, ${cost.month}: ${formatMoney(cost.amount, cost.currency)}`,
  });

  return c.json({ cost }, created ? 201 : 200);
});

internalProductRoutes.delete('/internal-products/:id/costs/:costId', async (c) => {
  const id = c.req.param('id');
  const cost = await getProductCost(db(c), c.req.param('costId'));
  // Checking the product too, so a cost id from one product cannot be deleted
  // through the URL of another.
  if (!cost || cost.product_id !== id) {
    return c.json({ error: 'not_found', message: 'No such cost on this product.' }, 404);
  }

  const product = await getInternalProduct(db(c), id);
  await deleteProductCost(db(c), cost.id);
  await recordAudit(db(c), {
    entity: 'product_cost',
    entity_id: cost.id,
    action: 'delete',
    actor: actor(c),
    summary: `Removed ${cost.provider} for ${product?.name ?? id}, ${cost.month}: ${formatMoney(cost.amount, cost.currency)}`,
  });
  return c.json({ deleted: true });
});

/**
 * The CEO summary. One currency, with every assumption it rests on returned
 * alongside the numbers so the screen can state them.
 */
internalProductRoutes.get('/ceo-summary', async (c) => {
  const settings = await getSettings(db(c));
  const [tools, payments, products, tables, monthlyCosts] = await Promise.all([
    listAllTools(db(c)),
    listPayments(db(c)),
    listInternalProducts(db(c)),
    rateTablesByMonth(db(c)),
    listAllProductCosts(db(c)),
  ]);

  return c.json(
    computeCeoSummary({
      tools,
      payments,
      products,
      monthlyCosts,
      tables,
      reportingCurrency: settings.reporting_currency,
      today: todayInTimezone(settings.timezone),
    }),
  );
});
