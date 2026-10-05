import { Hono } from 'hono';
import { toolCreateSchema, toolUpdateSchema, paymentCreateSchema, priceChangeSchema } from '../../shared/schema';
import { advanceByCycle, formatDate, todayInTimezone } from '../../shared/dates';
import type { Env, Variables } from '../context';
import { actor, db, featureDocuments, patchFrom, zodErrorResponse } from '../context';
import {
  archiveTool,
  createTool,
  distinctCategories,
  distinctOwners,
  getTool,
  listTools,
  listTrash,
  purgeOldTrash,
  purgeTool,
  restoreTool,
  trashTool,
  TRASH_RETENTION_DAYS,
  untrashTool,
  updateTool,
} from '../repo/tools';
import { createPayment, listPayments } from '../repo/payments';
import { listPriceChanges } from '../repo/priceChanges';
import { recordPriceChange } from '../pricing';
import { diffRecords, listAuditForEntity, recordAudit } from '../repo/audit';
import { listDocuments } from '../repo/documents';
import { getSettings } from '../repo/settings';
import { effectiveRenewalDate } from '../../shared/alerts';
import type { ToolStatus } from '../../shared/types';

export const toolsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

toolsRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  const status = url.searchParams.getAll('status') as ToolStatus[];
  const tools = await listTools(db(c), {
    status: status.length > 0 ? status : undefined,
    category: url.searchParams.get('category') ?? undefined,
    owner: url.searchParams.get('owner') ?? undefined,
    search: url.searchParams.get('search') ?? undefined,
    includeArchived: url.searchParams.get('include_archived') === 'true',
  });
  return c.json({ tools });
});

/** Values that populate the filter dropdowns and the category datalist. */
toolsRoutes.get('/options', async (c) => {
  const [categories, owners] = await Promise.all([
    distinctCategories(db(c)),
    distinctOwners(db(c)),
  ]);
  return c.json({ categories, owners });
});

/**
 * Deleted tools, most recent first. A row sits here until someone restores it
 * or the retention window passes -- swept on every visit here, so trash never
 * needs its own scheduled job to stay tidy.
 */
toolsRoutes.get('/trash', async (c) => {
  await purgeOldTrash(db(c), TRASH_RETENTION_DAYS);
  const tools = await listTrash(db(c));
  return c.json({ tools, retention_days: TRASH_RETENTION_DAYS });
});

toolsRoutes.post('/', async (c) => {
  const parsed = toolCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const tool = await createTool(db(c), parsed.data);
  await recordAudit(db(c), {
    entity: 'tool',
    entity_id: tool.id,
    action: 'create',
    actor: actor(c),
    summary: `Added ${tool.name}`,
  });
  return c.json({ tool }, 201);
});

toolsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const tool = await getTool(db(c), id);
  if (!tool) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  const [payments, audit, documents, priceChanges] = await Promise.all([
    listPayments(db(c), { toolId: id }),
    listAuditForEntity(db(c), 'tool', id),
    featureDocuments(c) ? listDocuments(db(c), id) : Promise.resolve([]),
    listPriceChanges(db(c), id),
  ]);

  return c.json({
    tool,
    payments,
    audit,
    documents,
    documents_enabled: featureDocuments(c),
    price_changes: priceChanges,
  });
});

/**
 * Change a tool's price from a date: "Claude is $22 from 1 November".
 *
 * Bills due from that date use the new price until the next change; paid
 * bills keep what was paid. The start date may be in the past (the invoice
 * already showed the new price) or the future (the vendor announced it).
 */
toolsRoutes.post('/:id/price-changes', async (c) => {
  const id = c.req.param('id');
  const tool = await getTool(db(c), id);
  if (!tool || tool.deleted_at) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  const parsed = priceChangeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const settings = await getSettings(db(c));
  const result = await recordPriceChange(
    db(c),
    tool,
    {
      amount: parsed.data.amount,
      currency: parsed.data.currency ?? tool.currency,
      effective_from: parsed.data.effective_from,
      note: parsed.data.note ?? null,
    },
    actor(c),
    todayInTimezone(settings.timezone),
  );
  return c.json(
    { price_change: result.change, tool: result.tool, repriced: result.repriced.length },
    201,
  );
});

toolsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const before = await getTool(db(c), id);
  if (!before) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = toolUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const tool = await updateTool(db(c), id, patchFrom(raw, parsed.data));
  if (!tool) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  const changes = diffRecords(
    before as unknown as Record<string, unknown>,
    tool as unknown as Record<string, unknown>,
  );
  // An edit that changed nothing is not worth a history entry.
  if (changes.length > 0) {
    await recordAudit(db(c), {
      entity: 'tool',
      entity_id: id,
      action: 'update',
      actor: actor(c),
      summary: `Updated ${changes.map((ch) => ch.field).join(', ')}`,
      changes,
    });
  }

  // A cost typed into the edit form is a price change starting today: it is
  // recorded in the price history and reaches the bills not yet paid, the same
  // as one made with "Change price". The edit above is already audited.
  const priceChanged =
    before.cost_amount !== tool.cost_amount || before.currency !== tool.currency;
  if (priceChanged && before.cost_amount !== null && tool.cost_amount !== null) {
    const settings = await getSettings(db(c));
    const result = await recordPriceChange(
      db(c),
      before,
      { amount: tool.cost_amount, currency: tool.currency, effective_from: todayInTimezone(settings.timezone), note: null },
      actor(c),
      todayInTimezone(settings.timezone),
      { auditTool: false },
    );
    return c.json({ tool: result.tool });
  }
  return c.json({ tool });
});

/**
 * Archive rather than delete: the ledger's value is that cancelled tools and
 * their payment history remain answerable.
 */
toolsRoutes.post('/:id/archive', async (c) => {
  const id = c.req.param('id');
  const settings = await getSettings(db(c));
  const body = (await c.req.json().catch(() => ({}))) as { cancelled_on?: string };
  const cancelledOn = body.cancelled_on || todayInTimezone(settings.timezone);

  const tool = await archiveTool(db(c), id, cancelledOn);
  if (!tool) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  await recordAudit(db(c), {
    entity: 'tool',
    entity_id: id,
    action: 'archive',
    actor: actor(c),
    summary: `Marked ${tool.name} cancelled as of ${cancelledOn}`,
  });
  return c.json({ tool });
});

toolsRoutes.post('/:id/restore', async (c) => {
  const id = c.req.param('id');
  const tool = await restoreTool(db(c), id);
  if (!tool) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  await recordAudit(db(c), {
    entity: 'tool',
    entity_id: id,
    action: 'restore',
    actor: actor(c),
    summary: `Restored ${tool.name} to active`,
  });
  return c.json({ tool });
});

/**
 * Deletes a tool into the trash: it disappears from every screen at once, but
 * the row and its payment history are untouched, so this is not the point of
 * no return -- `POST /:id/undelete` is, until the retention window passes.
 */
toolsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const tool = await getTool(db(c), id);
  if (!tool) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);
  if (tool.deleted_at) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  await trashTool(db(c), id, actor(c));
  await recordAudit(db(c), {
    entity: 'tool',
    entity_id: id,
    action: 'delete',
    actor: actor(c),
    summary: `Moved ${tool.name} to Trash`,
  });
  return c.json({ ok: true });
});

toolsRoutes.post('/:id/undelete', async (c) => {
  const id = c.req.param('id');
  const tool = await getTool(db(c), id);
  if (!tool || !tool.deleted_at) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  const restored = await untrashTool(db(c), id);
  await recordAudit(db(c), {
    entity: 'tool',
    entity_id: id,
    action: 'restore',
    actor: actor(c),
    summary: `Restored ${tool.name} from Trash`,
  });
  return c.json({ tool: restored });
});

/** Skips the retention window for one row -- for someone who wants it gone now, not in 30 days. */
toolsRoutes.delete('/trash/:id', async (c) => {
  const id = c.req.param('id');
  const tool = await getTool(db(c), id);
  if (!tool || !tool.deleted_at) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  await purgeTool(db(c), id);
  await recordAudit(db(c), {
    entity: 'tool',
    entity_id: id,
    action: 'delete',
    actor: actor(c),
    summary: `Permanently deleted ${tool.name}`,
  });
  return c.json({ ok: true });
});

/**
 * Schedule the next payment for a tool from its billing cycle.
 *
 * Saves re-typing the same amount every period, and means a renewal date in
 * the record turns into an actual chaseable due date in the ledger.
 *
 * Three things it refuses, because each one used to leave a wrong row in the
 * payment history that the tool page gave no way to remove:
 *   - no amount: a tool with no cost would have produced a ₹0 payment;
 *   - a second payment on the same due date: the date is taken from the
 *     renewal date, so pressing the button twice duplicated the row;
 *   - a date in the past for an auto-renewing tool whose stored renewal date
 *     has drifted: it uses the date the reminders engine does, rolled forward
 *     by whole cycles, instead of a stale one that would show as overdue.
 */
toolsRoutes.post('/:id/payments', async (c) => {
  const id = c.req.param('id');
  const tool = await getTool(db(c), id);
  if (!tool) return c.json({ error: 'not_found', message: 'No such tool.' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const settings = await getSettings(db(c));
  const dueDate =
    (body['due_date'] as string) || effectiveRenewalDate(tool, todayInTimezone(settings.timezone));
  if (!dueDate) {
    return c.json(
      {
        error: 'missing_due_date',
        message: tool.renewal_date
          ? `The renewal date (${formatDate(tool.renewal_date)}) has passed and ${tool.name} does not auto-renew. Update its renewal date first.`
          : 'This tool has no renewal date, so give the payment a due date.',
      },
      400,
    );
  }

  if (body['amount'] === undefined && tool.cost_amount === null) {
    return c.json(
      {
        error: 'missing_cost',
        message: `${tool.name} has no cost yet. Enter its cost first, so the payment has an amount.`,
      },
      400,
    );
  }

  const existing = await listPayments(db(c), { toolId: id });
  if (existing.some((p) => p.due_date === dueDate)) {
    return c.json(
      {
        error: 'already_scheduled',
        message: `A payment due ${formatDate(dueDate)} is already in ${tool.name}'s payment history. To schedule the one after it, update the renewal date first.`,
      },
      409,
    );
  }

  const periodEnd = advanceByCycle(dueDate, tool.billing_cycle);
  const parsed = paymentCreateSchema.safeParse({
    tool_id: id,
    due_date: dueDate,
    period_start: dueDate,
    period_end: periodEnd,
    amount: body['amount'] ?? tool.cost_amount ?? 0,
    currency: body['currency'] ?? tool.currency,
    status: 'due',
    ...body,
  });
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const payment = await createPayment(db(c), parsed.data);
  await recordAudit(db(c), {
    entity: 'payment',
    entity_id: payment.id,
    action: 'create',
    actor: actor(c),
    summary: `Scheduled a payment for ${tool.name} due ${payment.due_date}`,
  });
  return c.json({ payment }, 201);
});
