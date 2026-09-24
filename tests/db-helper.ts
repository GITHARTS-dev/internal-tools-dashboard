import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { sqliteDb } from '../src/server/repo/sqlite';
import type { Db } from '../src/server/repo/db';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

/**
 * A fresh in-memory database with every real migration applied, in order.
 *
 * Same SQL, same CHECK constraints, same UNIQUE indexes as production -- so a
 * test that passes here is exercising the schema that ships, not a mock of it.
 *
 * The directory is read rather than listed by hand: a new migration that the
 * app depends on but the tests never apply would otherwise pass CI and fail on
 * the first real request.
 */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function testDb(): { db: Db; raw: Database.Database } {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const file of migrationFiles()) {
    raw.exec(readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8'));
  }
  return { db: sqliteDb(raw), raw };
}

export function testEnv(db: Db, overrides: Record<string, unknown> = {}) {
  return { DB: db, APP_ENV: 'test', FEATURE_DOCUMENTS: 'false', ...overrides };
}

const BASE = 'http://localhost';

export async function api(
  env: Record<string, unknown>,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any; text: string }> {
  const { app } = await import('../src/server/index');
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': typeof body === 'string' ? 'text/csv' : 'application/json' };
  }
  if (headers) {
    init.headers = { ...(init.headers as Record<string, string>), ...headers };
  }
  const response = await app.fetch(new Request(`${BASE}${path}`, init), env as never);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON responses (CSV downloads) are read via `text`.
  }
  return { status: response.status, json, text };
}

/** A minimal valid tool payload; override whatever a test cares about. */
export function toolPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Canva Teams',
    vendor: 'Canva',
    category: 'Design',
    status: 'active',
    owner_name: 'Priya Nair',
    owner_email: 'priya@example.com',
    billing_cycle: 'annual',
    cost_amount: 1499000,
    currency: 'INR',
    seats_purchased: 5,
    seats_used: 5,
    renewal_date: '2027-03-14',
    auto_renew: true,
    cancellation_notice_days: 30,
    ...overrides,
  };
}
