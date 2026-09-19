/**
 * An in-memory stand-in for the real API, used only by the standalone demo
 * build.
 *
 * It reuses the app's actual shared logic -- computeAlerts, the metrics, the
 * Zod schemas, the CSV parser, the money and date maths -- so what the demo
 * shows is the real behaviour, not a mock-up of it. Only persistence differs:
 * edits live in memory and reset when the page is reloaded.
 *
 * "Today" is pinned to the date the demo data was written for, so the worked
 * example (an overdue bill, a cancellation window that has just closed) stays
 * the same however long from now it is opened.
 */

import snapshot from './data.json';
import { computeAlerts } from '../../shared/alerts';
import {
  computeCategorySpend,
  computeKpis,
  computePaidByMonth,
  computeRenewalTimeline,
} from '../../shared/metrics';
import { advanceByCycle } from '../../shared/dates';
import { parseCsv, toCsv } from '../../shared/csv';
import { parseMoneyInput, toDecimalString } from '../../shared/money';
import { toolCreateSchema, toolUpdateSchema } from '../../shared/schema';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type AuditEntry,
  type DataStatus,
  type Payment,
  type Tool,
} from '../../shared/types';
import { ApiError } from '../lib/errors';

export const DEMO_TODAY = '2026-09-18';

interface Snapshot {
  tools: Tool[];
  payments: Payment[];
  audit: AuditEntry[];
  settings: Record<string, string>;
}

const source = snapshot as unknown as Snapshot;

let tools: Tool[] = structuredClone(source.tools);
let payments: Payment[] = structuredClone(source.payments);
let audit: AuditEntry[] = structuredClone(source.audit);
let rawSettings: Record<string, string> = { ...source.settings };

/** A touch of latency, so loading states are visible rather than skipped. */
function reply<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 90));
}

function uid(): string {
  return `demo-${Math.random().toString(36).slice(2, 10)}`;
}

function now(): string {
  return new Date().toISOString();
}

function parseList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) return parsed;
  } catch {
    // fall through to the default
  }
  return fallback;
}

function settings(): AppSettings {
  return {
    timezone: rawSettings['timezone'] || DEFAULT_SETTINGS.timezone,
    default_currency: rawSettings['default_currency'] || DEFAULT_SETTINGS.default_currency,
    renewal_lead_days: parseList(rawSettings['renewal_lead_days'], DEFAULT_SETTINGS.renewal_lead_days),
    payment_lead_days: parseList(rawSettings['payment_lead_days'], DEFAULT_SETTINGS.payment_lead_days),
    notice_lead_days: parseList(rawSettings['notice_lead_days'], DEFAULT_SETTINGS.notice_lead_days),
    seat_underuse_ratio: Number(rawSettings['seat_underuse_ratio'] ?? DEFAULT_SETTINGS.seat_underuse_ratio),
    digest_weekday: Number(rawSettings['digest_weekday'] ?? DEFAULT_SETTINGS.digest_weekday),
    digest_horizon_days: Number(rawSettings['digest_horizon_days'] ?? DEFAULT_SETTINGS.digest_horizon_days),
    teams_webhook_url: rawSettings['teams_webhook_url'] ?? '',
    email_from: rawSettings['email_from'] ?? '',
    email_to: rawSettings['email_to'] ?? '',
  };
}

function record(entity: string, entityId: string, action: AuditEntry['action'], summary: string, changes?: unknown) {
  audit.unshift({
    id: uid(),
    entity,
    entity_id: entityId,
    action,
    actor: 'you@demo',
    summary,
    diff_json: changes ? JSON.stringify(changes) : null,
    created_at: now(),
  });
}

function validationError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): ApiError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return new ApiError('Some fields need fixing.', 400, fields);
}

/** Same PATCH semantics as the server: only write what the caller sent. */
function onlySent<T extends Record<string, unknown>>(raw: unknown, parsed: T): Partial<T> {
  if (!raw || typeof raw !== 'object') return {};
  const sent = new Set(Object.keys(raw as Record<string, unknown>));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) if (sent.has(key)) out[key] = value;
  return out as Partial<T>;
}

function download(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const isDemoId = (id: string) => id.startsWith('seed-');

function dataStatus(): DataStatus {
  const demo = tools.filter((t) => isDemoId(t.id)).length;
  return { tools: tools.length, payments: payments.length, demo_tools: demo, own_tools: tools.length - demo };
}

function dropDemoRows(): void {
  tools = tools.filter((t) => !isDemoId(t.id));
  payments = payments.filter((p) => !isDemoId(p.tool_id));
  audit = audit.filter((a) => !isDemoId(a.id) && !isDemoId(a.entity_id));
}

const TOOL_CSV_COLUMNS = [
  'name', 'vendor', 'category', 'status', 'owner_name', 'owner_email', 'department',
  'billing_cycle', 'cost', 'currency', 'seats_purchased', 'seats_used', 'renewal_date',
  'auto_renew', 'cancellation_notice_days', 'account_ref', 'billing_email',
  'payment_method', 'vendor_url', 'started_on', 'cancelled_on', 'notes',
];

export const demoApi = {
  isDemo: true,
  demoToday: DEMO_TODAY,

  async dashboard(date?: string) {
    const today = date || DEMO_TODAY;
    const alerts = computeAlerts(tools, payments, settings(), today);
    return reply({
      today,
      timezone: settings().timezone,
      kpis: computeKpis(tools, payments, alerts, today),
      alerts,
      category_spend: computeCategorySpend(tools),
      renewal_timeline: computeRenewalTimeline(tools, today, 90),
      paid_by_month: computePaidByMonth(payments, 12, today),
      recent_activity: audit.slice(0, 12),
    });
  },

  async history() {
    const totals = new Map<string, { amount: number; currency: string }>();
    for (const payment of payments) {
      if (payment.status !== 'paid') continue;
      const existing = totals.get(payment.tool_id);
      totals.set(payment.tool_id, {
        amount: (existing?.amount ?? 0) + payment.amount,
        currency: payment.currency,
      });
    }
    return reply({
      archived: tools
        .filter((t) => t.status === 'cancelled' || t.status === 'expired')
        .map((tool) => ({ tool, lifetime_paid: totals.get(tool.id) ?? null })),
    });
  },

  async tools(params: Record<string, string> = {}) {
    let list = tools.filter((t) =>
      params['include_archived'] === 'true' ? true : t.status === 'active' || t.status === 'trial',
    );
    if (params['category']) list = list.filter((t) => t.category === params['category']);
    if (params['owner']) list = list.filter((t) => t.owner_name === params['owner']);
    if (params['search']) {
      const needle = params['search'].toLowerCase();
      list = list.filter((t) =>
        [t.name, t.vendor, t.owner_name, t.notes].some((v) => (v ?? '').toLowerCase().includes(needle)),
      );
    }
    return reply({ tools: [...list].sort((a, b) => a.name.localeCompare(b.name)) });
  },

  async toolOptions() {
    return reply({
      categories: [...new Set(tools.map((t) => t.category))].sort(),
      owners: [...new Map(tools.filter((t) => t.owner_name).map((t) => [t.owner_name, { name: t.owner_name, email: t.owner_email }])).values()],
    });
  },

  async tool(id: string) {
    const tool = tools.find((t) => t.id === id);
    if (!tool) throw new ApiError('No such tool.', 404);
    return reply({
      tool,
      payments: payments.filter((p) => p.tool_id === id).sort((a, b) => b.due_date.localeCompare(a.due_date)),
      audit: audit.filter((a) => a.entity === 'tool' && a.entity_id === id),
      documents: [],
      documents_enabled: false,
    });
  },

  async createTool(body: unknown) {
    const parsed = toolCreateSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);

    const tool = {
      ...parsed.data,
      id: uid(),
      cancelled_on: parsed.data.cancelled_on ?? null,
      created_at: now(),
      updated_at: now(),
    } as unknown as Tool;
    tools.push(tool);
    record('tool', tool.id, 'create', `Added ${tool.name}`);
    return reply({ tool });
  },

  async updateTool(id: string, body: unknown) {
    const index = tools.findIndex((t) => t.id === id);
    if (index === -1) throw new ApiError('No such tool.', 404);

    const parsed = toolUpdateSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);

    const before = tools[index]!;
    const patch = onlySent(body, parsed.data as Record<string, unknown>);
    const after = { ...before, ...patch, updated_at: now() } as Tool;
    tools[index] = after;

    const beforeFields = before as unknown as Record<string, unknown>;
    const afterFields = after as unknown as Record<string, unknown>;
    const changes = Object.keys(patch)
      .filter((key) => beforeFields[key] !== afterFields[key])
      .map((key) => ({ field: key, from: beforeFields[key] ?? null, to: afterFields[key] ?? null }));
    if (changes.length > 0) {
      record('tool', id, 'update', `Updated ${changes.map((c) => c.field).join(', ')}`, changes);
    }
    return reply({ tool: after });
  },

  async archiveTool(id: string, cancelled_on?: string) {
    const index = tools.findIndex((t) => t.id === id);
    if (index === -1) throw new ApiError('No such tool.', 404);
    const date = cancelled_on || DEMO_TODAY;
    tools[index] = { ...tools[index]!, status: 'cancelled', cancelled_on: date, updated_at: now() };
    record('tool', id, 'archive', `Marked ${tools[index]!.name} cancelled as of ${date}`);
    return reply({ tool: tools[index]! });
  },

  async restoreTool(id: string) {
    const index = tools.findIndex((t) => t.id === id);
    if (index === -1) throw new ApiError('No such tool.', 404);
    tools[index] = { ...tools[index]!, status: 'active', cancelled_on: null, updated_at: now() };
    record('tool', id, 'restore', `Restored ${tools[index]!.name} to active`);
    return reply({ tool: tools[index]! });
  },

  async schedulePayment(toolId: string, body: Record<string, unknown> = {}) {
    const tool = tools.find((t) => t.id === toolId);
    if (!tool) throw new ApiError('No such tool.', 404);

    const dueDate = (body['due_date'] as string) || tool.renewal_date;
    if (!dueDate) {
      throw new ApiError('This tool has no renewal date, so give the payment a due date.', 400);
    }

    const payment: Payment = {
      id: uid(),
      tool_id: toolId,
      period_start: dueDate,
      period_end: advanceByCycle(dueDate, tool.billing_cycle),
      due_date: dueDate,
      amount: (body['amount'] as number) ?? tool.cost_amount ?? 0,
      currency: tool.currency,
      status: 'due',
      paid_on: null,
      paid_by: null,
      invoice_ref: null,
      invoice_url: null,
      notes: null,
      created_at: now(),
      updated_at: now(),
    };
    payments.push(payment);
    record('payment', payment.id, 'create', `Scheduled a payment for ${tool.name} due ${dueDate}`);
    return reply({ payment });
  },

  async payments(params: Record<string, string | string[]> = {}) {
    let list = [...payments];
    const status = params['status'];
    if (status) {
      const wanted = Array.isArray(status) ? status : [status];
      list = list.filter((p) => wanted.includes(p.status));
    }
    if (params['tool_id']) list = list.filter((p) => p.tool_id === params['tool_id']);
    return reply({
      payments: list.sort((a, b) => b.due_date.localeCompare(a.due_date)),
      tool_names: Object.fromEntries(tools.map((t) => [t.id, t.name])),
    });
  },

  async markPaid(id: string, body: Record<string, unknown> = {}) {
    const index = payments.findIndex((p) => p.id === id);
    if (index === -1) throw new ApiError('No such payment.', 404);
    const paidOn = (body['paid_on'] as string) || DEMO_TODAY;
    payments[index] = {
      ...payments[index]!,
      status: 'paid',
      paid_on: paidOn,
      paid_by: (body['paid_by'] as string) ?? 'you@demo',
      invoice_ref: (body['invoice_ref'] as string) ?? payments[index]!.invoice_ref,
      updated_at: now(),
    };
    record('payment', id, 'update', `Marked paid on ${paidOn}`, [
      { field: 'status', from: 'due', to: 'paid' },
    ]);
    return reply({ payment: payments[index]! });
  },

  async bulkMarkPaid(ids: string[], paid_on?: string) {
    let count = 0;
    for (const id of ids) {
      const index = payments.findIndex((p) => p.id === id);
      if (index === -1) continue;
      payments[index] = {
        ...payments[index]!,
        status: 'paid',
        paid_on: paid_on || DEMO_TODAY,
        paid_by: 'you@demo',
        updated_at: now(),
      };
      count++;
    }
    record('payment', 'bulk', 'update', `Marked ${count} payments paid (bulk)`);
    return reply({ count });
  },

  async deletePayment(id: string) {
    payments = payments.filter((p) => p.id !== id);
    return reply({ ok: true as const });
  },

  async settings() {
    const current = settings();
    return reply({
      settings: current,
      features: { documents: false },
      channels: [
        { name: 'console', configured: true },
        { name: 'teams', configured: Boolean(current.teams_webhook_url) },
        { name: 'email', configured: false },
      ],
    });
  },

  async updateSettings(patch: Record<string, string>) {
    rawSettings = { ...rawSettings, ...patch };
    record('settings', 'global', 'update', `Updated ${Object.keys(patch).join(', ')}`);
    return reply({ settings: settings() });
  },

  async dryRun(date?: string, digest = false) {
    const today = date || DEMO_TODAY;
    const current = settings();
    const effective = digest
      ? {
          ...current,
          renewal_lead_days: [current.digest_horizon_days],
          payment_lead_days: [current.digest_horizon_days],
          notice_lead_days: [current.digest_horizon_days],
        }
      : current;
    const alerts = computeAlerts(tools, payments, effective, today);

    return reply({
      today,
      timezone: current.timezone,
      alerts,
      dry_run: true,
      alert_dispatch: {
        considered: alerts.length,
        notifiable: alerts.length,
        channels: [
          {
            channel: 'console',
            status: 'skipped',
            detail: 'dry run: nothing sent or recorded',
            new_alerts: alerts.length,
            alert_titles: alerts.map((a) => a.title),
          },
          {
            channel: 'teams',
            status: 'skipped',
            detail: current.teams_webhook_url ? 'dry run: nothing sent or recorded' : 'not configured',
            new_alerts: current.teams_webhook_url ? alerts.length : 0,
            alert_titles: [],
          },
          {
            channel: 'email',
            status: 'skipped',
            detail: 'not configured',
            new_alerts: 0,
            alert_titles: [],
          },
        ],
      },
      digest_dispatch: null,
    });
  },

  async runReminders() {
    return this.dryRun();
  },

  async dataStatus() {
    return reply({ status: dataStatus(), enabled: true });
  },

  async loadDemoData() {
    dropDemoRows();
    tools = [...tools, ...structuredClone(source.tools)];
    payments = [...payments, ...structuredClone(source.payments)];
    audit = [...structuredClone(source.audit), ...audit];
    record('data', 'demo', 'create', 'Loaded the demo data');
    return reply({ status: dataStatus() });
  },

  async removeDemoData() {
    dropDemoRows();
    record('data', 'demo', 'delete', 'Removed the demo data');
    return reply({ status: dataStatus() });
  },

  async clearAllData() {
    tools = [];
    payments = [];
    audit = [];
    record('data', 'all', 'delete', 'Deleted all tools and payments');
    return reply({ status: dataStatus() });
  },

  async notifications() {
    return reply({ notifications: [] });
  },

  async audit() {
    return reply({ audit });
  },

  async importCsv(csv: string, commit: boolean) {
    const records = parseCsv(csv);
    if (records.length === 0) throw new ApiError('That file had no rows in it.', 400);

    const byName = new Map(tools.map((t) => [t.name.trim().toLowerCase(), t]));
    const results: Array<{ row: number; name: string; action: string; message: string }> = [];
    let created = 0;
    let updated = 0;
    let rejected = 0;

    for (const [index, raw] of records.entries()) {
      const rowNumber = index + 2;
      const name = (raw['name'] ?? '').trim();
      if (!name) {
        rejected++;
        results.push({ row: rowNumber, name: '', action: 'reject', message: 'No name in this row.' });
        continue;
      }

      const currency = (raw['currency'] || 'INR').toUpperCase();
      const parsed = toolCreateSchema.safeParse({
        ...raw,
        name,
        category: raw['category'],
        status: raw['status'] || 'active',
        billing_cycle: raw['billing_cycle'] || 'monthly',
        cost_amount: raw['cost'] ? parseMoneyInput(raw['cost'], currency) : null,
        currency,
        auto_renew: ['yes', 'y', 'true', '1'].includes((raw['auto_renew'] ?? 'yes').toLowerCase()),
        cancellation_notice_days: raw['cancellation_notice_days'] || 0,
      });

      if (!parsed.success) {
        rejected++;
        const error = validationError(parsed.error);
        results.push({
          row: rowNumber,
          name,
          action: 'reject',
          message: Object.entries(error.fields).map(([f, m]) => `${f}: ${m}`).join('; '),
        });
        continue;
      }

      const match = byName.get(name.toLowerCase());
      if (match) {
        updated++;
        results.push({ row: rowNumber, name, action: 'update', message: `Would update "${name}".` });
        if (commit) {
          const at = tools.findIndex((t) => t.id === match.id);
          tools[at] = { ...tools[at]!, ...parsed.data, updated_at: now() } as Tool;
        }
      } else {
        created++;
        results.push({ row: rowNumber, name, action: 'create', message: `Would add "${name}".` });
        if (commit) {
          tools.push({ ...parsed.data, id: uid(), created_at: now(), updated_at: now() } as unknown as Tool);
        }
      }
    }

    if (commit) {
      record('import', now(), 'create', `Imported CSV: ${created} added, ${updated} updated, ${rejected} rejected`);
    }
    return reply({
      committed: commit,
      summary: { total: records.length, created, updated, rejected },
      results,
    });
  },

  /**
   * Client-side CSV generation, so exports work with no server to call.
   *
   * The embedded viewer blocks downloads a page starts itself, so when that is
   * where we are running, say so rather than appearing to do nothing.
   */
  async downloadCsv(kind: 'tools' | 'payments' | 'template') {
    if (window.self !== window.top) {
      throw new ApiError(
        'Downloads are blocked in this embedded preview. Run the app locally to export CSV.',
        400,
      );
    }
    if (kind === 'payments') {
      const names = Object.fromEntries(tools.map((t) => [t.id, t.name]));
      download(
        'payments.csv',
        toCsv(
          ['tool', 'due_date', 'period_start', 'period_end', 'amount', 'currency', 'status', 'paid_on', 'paid_by', 'invoice_ref', 'notes'],
          payments.map((p) => ({
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
          })),
        ),
      );
      return;
    }

    const rows = (kind === 'template' ? tools.slice(0, 1) : tools).map((tool) => ({
      ...tool,
      cost: toDecimalString(tool.cost_amount, tool.currency),
      auto_renew: tool.auto_renew ? 'yes' : 'no',
    }));
    download(kind === 'template' ? 'tools-template.csv' : 'tools.csv', toCsv(TOOL_CSV_COLUMNS, rows));
  },
};

/** The alias in vite.demo.config.ts points `./lib/apiClient` here. */
export const api = demoApi;
