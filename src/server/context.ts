import type { Context } from 'hono';
import type { Db } from './repo/db';

/** Bindings the Worker receives. `DB` is a D1 binding in production. */
export interface Env {
  DB: Db;
  FEATURE_DOCUMENTS?: string;
  APP_ENV?: string;
  TEAMS_WEBHOOK_URL?: string;
  EMAIL_PROVIDER?: string;
  [key: string]: unknown;
}

export type AppContext = Context<{ Bindings: Env }>;

export function db(c: AppContext): Db {
  return c.env.DB;
}

/**
 * Who is making this change, for the audit log.
 *
 * There is no authentication yet, so this trusts a header and falls back to
 * 'web'. When sign-in is added, this is the single place that changes -- every
 * audit row already flows through it.
 */
export function actor(c: AppContext): string {
  const header = c.req.header('x-actor');
  return header?.trim().slice(0, 120) || 'web';
}

export function envVars(c: AppContext): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(c.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function featureDocuments(c: AppContext): boolean {
  return String(c.env.FEATURE_DOCUMENTS ?? 'false').toLowerCase() === 'true';
}

/** Turn a Zod error into something a form can display field by field. */
export function zodErrorResponse(error: { issues: Array<{ path: PropertyKey[]; message: string }> }) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_';
    if (!fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return { error: 'validation_failed', message: 'Some fields need fixing.', fields: fieldErrors };
}

/**
 * Restrict a validated patch to the fields the caller actually sent.
 *
 * Zod applies `.default()` values even through `.partial()`, so parsing a
 * PATCH body of `{name: "..."}` against the update schema yields a full object
 * with `billing_cycle: "monthly"`, `status: "active"`, `currency: "INR"` and
 * so on. Writing that straight to the database would silently reset every
 * field the user did not mention -- renaming a tool would wipe its billing
 * cycle.
 *
 * Intersecting with the raw body's own keys gives PATCH the semantics it is
 * supposed to have: touch exactly what was sent, leave everything else alone.
 */
export function patchFrom<T extends Record<string, unknown>>(raw: unknown, parsed: T): Partial<T> {
  if (!raw || typeof raw !== 'object') return {};
  const sent = new Set(Object.keys(raw as Record<string, unknown>));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (sent.has(key)) out[key] = value;
  }
  return out as Partial<T>;
}
