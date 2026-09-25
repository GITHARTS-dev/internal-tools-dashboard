import type { Context } from 'hono';
import type { Db } from './repo/db';

/** Bindings the Worker receives. `DB` is a D1 binding in production. */
export interface Env {
  DB: Db;
  FEATURE_DOCUMENTS?: string;
  APP_ENV?: string;
  TEAMS_WEBHOOK_URL?: string;
  EMAIL_PROVIDER?: string;
  /** The Entra tenant and app registration the SPA signs into. Unset: no token is required (see auth/middleware.ts). */
  AAD_TENANT_ID?: string;
  AAD_CLIENT_ID?: string;
  [key: string]: unknown;
}

/** Set by `requireAuth()` (auth/middleware.ts) once a bearer token verifies. */
export interface Variables {
  actor?: string;
  actorOid?: string;
}

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export function db(c: AppContext): Db {
  return c.env.DB;
}

/**
 * Who is making this change, for the audit log.
 *
 * The verified identity from the access token wins whenever one exists --
 * `requireAuth()` puts it here after checking the token's signature, issuer
 * and audience, so it cannot be spoofed by the caller. The `x-actor` header is
 * the fallback for local development and tests, where `AAD_TENANT_ID` /
 * `AAD_CLIENT_ID` are unset and no token is required in the first place; it is
 * never consulted once sign-in is actually configured.
 */
export function actor(c: AppContext): string {
  const verified = c.get('actor');
  if (verified) return verified;
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
