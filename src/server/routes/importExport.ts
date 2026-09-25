import { Hono } from 'hono';
import { parseCsv, toCsv } from '../../shared/csv';
import { toolCreateSchema } from '../../shared/schema';
import { toDecimalString, parseMoneyInput } from '../../shared/money';
import type { Env, Variables } from '../context';
import { actor, db, zodErrorResponse } from '../context';
import { createTool, listAllTools, listTools, updateTool } from '../repo/tools';
import { listPayments } from '../repo/payments';
import { recordAudit } from '../repo/audit';

export const importExportRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** The canonical column set: what export writes and what import expects. */
export const TOOL_CSV_COLUMNS = [
  'name', 'vendor', 'category', 'status', 'owner_name', 'owner_email', 'department',
  'billing_cycle', 'cost', 'currency', 'seats_purchased', 'seats_used', 'renewal_date',
  'auto_renew', 'cancellation_notice_days', 'account_ref', 'billing_email',
  'payment_method', 'vendor_url', 'started_on', 'cancelled_on', 'notes',
] as const;

importExportRoutes.get('/export/tools.csv', async (c) => {
  const tools = await listAllTools(db(c));
  const rows = tools.map((tool) => ({
    ...tool,
    // Exported as a plain decimal so the file opens sensibly in Excel and can
    // be edited by hand before being imported back.
    cost: toDecimalString(tool.cost_amount, tool.currency),
    auto_renew: tool.auto_renew ? 'yes' : 'no',
  }));

  return new Response(toCsv([...TOOL_CSV_COLUMNS], rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="tools.csv"',
    },
  });
});

importExportRoutes.get('/export/payments.csv', async (c) => {
  const [payments, tools] = await Promise.all([listPayments(db(c)), listAllTools(db(c))]);
  const names = Object.fromEntries(tools.map((t) => [t.id, t.name]));

  const rows = payments.map((p) => ({
    tool: names[p.tool_id] ?? p.tool_id,
    due_date: p.due_date,
    period_start: p.period_start,
    period_end: p.period_end,
    amount: toDecimalString(p.amount, p.currency),
    currency: p.currency,
    status: p.status,
    paid_on: p.paid_on,
    paid_by: p.paid_by,
    invoice_ref: p.invoice_ref,
    notes: p.notes,
  }));

  const headers = [
    'tool', 'due_date', 'period_start', 'period_end', 'amount', 'currency',
    'status', 'paid_on', 'paid_by', 'invoice_ref', 'notes',
  ];
  return new Response(toCsv(headers, rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="payments.csv"',
    },
  });
});

/** A blank file with the right headers and one worked example row. */
importExportRoutes.get('/export/template.csv', () => {
  const example = {
    name: 'Canva Teams',
    vendor: 'Canva',
    category: 'Design',
    status: 'active',
    owner_name: 'Priya Nair',
    owner_email: 'priya@example.com',
    department: 'Marketing',
    billing_cycle: 'annual',
    cost: '14990.00',
    currency: 'INR',
    seats_purchased: '5',
    seats_used: '4',
    renewal_date: '2027-03-14',
    auto_renew: 'yes',
    cancellation_notice_days: '30',
    account_ref: 'CANVA-4821',
    billing_email: 'accounts@example.com',
    payment_method: 'HDFC corporate card',
    vendor_url: 'https://www.canva.com',
    started_on: '2024-03-14',
    cancelled_on: '',
    notes: 'Shared across the design and marketing teams.',
  };
  return new Response(toCsv([...TOOL_CSV_COLUMNS], [example]), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="tools-template.csv"',
    },
  });
});

const TRUTHY = new Set(['yes', 'y', 'true', '1', 'auto']);

export interface ImportRowResult {
  row: number;
  name: string;
  action: 'create' | 'update' | 'reject';
  message: string;
  fields?: Record<string, string>;
}

/**
 * Import tools from CSV.
 *
 * Dry run by default: it reports exactly what it WOULD do, row by row, and
 * writes nothing. Committing takes a second, explicit call with commit=true.
 * Nobody should discover what an import does by running it on real data.
 *
 * Rows are matched to existing tools by name (case-insensitive), so re-importing
 * an edited export updates in place instead of creating duplicates.
 */
importExportRoutes.post('/import', async (c) => {
  const commit = new URL(c.req.url).searchParams.get('commit') === 'true';
  const text = await c.req.text();
  if (!text.trim()) {
    return c.json({ error: 'empty', message: 'That file had no rows in it.' }, 400);
  }

  const records = parseCsv(text);
  if (records.length === 0) {
    return c.json({ error: 'empty', message: 'That file had headers but no rows.' }, 400);
  }

  const existing = await listTools(db(c), { includeArchived: true });
  const byName = new Map(existing.map((t) => [t.name.trim().toLowerCase(), t]));

  const results: ImportRowResult[] = [];
  let created = 0;
  let updated = 0;
  let rejected = 0;

  for (const [index, record] of records.entries()) {
    const rowNumber = index + 2; // +1 for the header, +1 for 1-based counting
    const name = (record['name'] ?? '').trim();

    if (!name) {
      rejected++;
      results.push({ row: rowNumber, name: '', action: 'reject', message: 'No name in this row.' });
      continue;
    }

    const currency = (record['currency'] || 'INR').toUpperCase();
    const candidate = {
      name,
      vendor: record['vendor'],
      category: record['category'],
      status: record['status'] || 'active',
      owner_name: record['owner_name'],
      owner_email: record['owner_email'],
      department: record['department'],
      billing_cycle: record['billing_cycle'] || 'monthly',
      cost_amount: record['cost'] ? parseMoneyInput(record['cost'], currency) : null,
      currency,
      seats_purchased: record['seats_purchased'],
      seats_used: record['seats_used'],
      renewal_date: record['renewal_date'],
      auto_renew: TRUTHY.has((record['auto_renew'] ?? 'yes').toLowerCase()),
      cancellation_notice_days: record['cancellation_notice_days'] || 0,
      account_ref: record['account_ref'],
      billing_email: record['billing_email'],
      payment_method: record['payment_method'],
      vendor_url: record['vendor_url'],
      notes: record['notes'],
      started_on: record['started_on'],
      cancelled_on: record['cancelled_on'],
    };

    const parsed = toolCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected++;
      const { fields } = zodErrorResponse(parsed.error);
      results.push({
        row: rowNumber,
        name,
        action: 'reject',
        message: Object.entries(fields)
          .map(([field, msg]) => `${field}: ${msg}`)
          .join('; '),
        fields,
      });
      continue;
    }

    const match = byName.get(name.toLowerCase());
    if (match) {
      updated++;
      results.push({ row: rowNumber, name, action: 'update', message: `Would update "${name}".` });
      if (commit) await updateTool(db(c), match.id, parsed.data);
    } else {
      created++;
      results.push({ row: rowNumber, name, action: 'create', message: `Would add "${name}".` });
      if (commit) await createTool(db(c), parsed.data);
    }
  }

  if (commit) {
    await recordAudit(db(c), {
      entity: 'import',
      entity_id: new Date().toISOString(),
      action: 'create',
      actor: actor(c),
      summary: `Imported CSV: ${created} added, ${updated} updated, ${rejected} rejected`,
    });
  }

  return c.json({
    committed: commit,
    summary: { total: records.length, created, updated, rejected },
    results,
  });
});
