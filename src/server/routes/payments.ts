import { Hono } from 'hono';
import { markPaidSchema, paymentUpdateSchema } from '../../shared/schema';
import { todayInTimezone } from '../../shared/dates';
import type { Env } from '../context';
import { actor, db, patchFrom, zodErrorResponse } from '../context';
import {
  deletePayment,
  getPayment,
  listPayments,
  markPaid,
  updatePayment,
} from '../repo/payments';
import { listTools } from '../repo/tools';
import { diffRecords, recordAudit } from '../repo/audit';
import { getSettings } from '../repo/settings';
import type { PaymentStatus } from '../../shared/types';

export const paymentsRoutes = new Hono<{ Bindings: Env }>();

/**
 * The ledger view. Tool names come back alongside the rows so the client does
 * not have to fetch every tool just to render a table.
 */
paymentsRoutes.get('/', async (c) => {
  const url = new URL(c.req.url);
  const status = url.searchParams.getAll('status') as PaymentStatus[];

  const payments = await listPayments(db(c), {
    toolId: url.searchParams.get('tool_id') ?? undefined,
    status: status.length > 0 ? status : undefined,
    dueFrom: url.searchParams.get('due_from') ?? undefined,
    dueTo: url.searchParams.get('due_to') ?? undefined,
  });

  const tools = await listTools(db(c), { includeArchived: true });
  const names = Object.fromEntries(tools.map((t) => [t.id, t.name]));

  return c.json({ payments, tool_names: names });
});

paymentsRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const before = await getPayment(db(c), id);
  if (!before) return c.json({ error: 'not_found', message: 'No such payment.' }, 404);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = paymentUpdateSchema.safeParse(raw);
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const payment = await updatePayment(db(c), id, patchFrom(raw, parsed.data));
  if (!payment) return c.json({ error: 'not_found', message: 'No such payment.' }, 404);

  const changes = diffRecords(
    before as unknown as Record<string, unknown>,
    payment as unknown as Record<string, unknown>,
  );
  if (changes.length > 0) {
    await recordAudit(db(c), {
      entity: 'payment',
      entity_id: id,
      action: 'update',
      actor: actor(c),
      summary: `Updated ${changes.map((ch) => ch.field).join(', ')}`,
      changes,
    });
  }
  return c.json({ payment });
});

paymentsRoutes.post('/:id/mark-paid', async (c) => {
  const id = c.req.param('id');
  const existing = await getPayment(db(c), id);
  if (!existing) return c.json({ error: 'not_found', message: 'No such payment.' }, 404);

  const parsed = markPaidSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const settings = await getSettings(db(c));
  const paidOn = parsed.data.paid_on || todayInTimezone(settings.timezone);

  const payment = await markPaid(db(c), id, {
    paid_on: paidOn,
    paid_by: parsed.data.paid_by ?? actor(c),
    invoice_ref: parsed.data.invoice_ref ?? null,
  });
  if (!payment) return c.json({ error: 'not_found', message: 'No such payment.' }, 404);

  await recordAudit(db(c), {
    entity: 'payment',
    entity_id: id,
    action: 'update',
    actor: actor(c),
    summary: `Marked paid on ${paidOn}`,
    changes: [{ field: 'status', from: existing.status, to: 'paid' }],
  });
  return c.json({ payment });
});

/** Mark several payments paid in one go, for a batch settled together. */
paymentsRoutes.post('/bulk-mark-paid', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[]; paid_on?: string };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : [];
  if (ids.length === 0) {
    return c.json({ error: 'no_ids', message: 'Select at least one payment.' }, 400);
  }

  const settings = await getSettings(db(c));
  const paidOn = body.paid_on || todayInTimezone(settings.timezone);
  const updated = [];

  for (const id of ids) {
    const payment = await markPaid(db(c), id, { paid_on: paidOn, paid_by: actor(c) });
    if (!payment) continue;
    updated.push(payment);
    await recordAudit(db(c), {
      entity: 'payment',
      entity_id: id,
      action: 'update',
      actor: actor(c),
      summary: `Marked paid on ${paidOn} (bulk)`,
    });
  }

  return c.json({ payments: updated, count: updated.length });
});

paymentsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const payment = await getPayment(db(c), id);
  if (!payment) return c.json({ error: 'not_found', message: 'No such payment.' }, 404);

  await deletePayment(db(c), id);
  await recordAudit(db(c), {
    entity: 'payment',
    entity_id: id,
    action: 'delete',
    actor: actor(c),
    summary: `Deleted a payment due ${payment.due_date}`,
  });
  return c.json({ ok: true });
});
