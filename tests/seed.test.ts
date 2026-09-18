import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { sqliteDb } from '../src/server/repo/sqlite';
import { api, testEnv } from './db-helper';

/**
 * The seed file is what anyone reviewing this app will actually look at, so
 * the worked example it produces is pinned here. If a rule changes and the
 * demo stops demonstrating overdue payments or a closed cancellation window,
 * this fails rather than quietly showing an empty dashboard.
 */
function seededEnv() {
  const raw = new Database(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../seed/dev-seed.sql', import.meta.url), 'utf8'));
  return testEnv(sqliteDb(raw));
}

describe('seed data', () => {
  it('loads cleanly against the real schema', async () => {
    const env = seededEnv();
    const res = await api(env, 'GET', '/api/tools?include_archived=true');
    expect(res.json.tools.length).toBeGreaterThanOrEqual(15);
  });

  it('shows a portfolio worth looking at on the anchor date', async () => {
    const env = seededEnv();
    const { json } = await api(env, 'GET', '/api/dashboard?date=2026-09-18');

    expect(json.kpis.active_tools).toBeGreaterThanOrEqual(12);
    expect(json.kpis.cancelled_tools).toBeGreaterThanOrEqual(3);
    expect(json.kpis.monthly_run_rate.INR).toBeGreaterThan(0);
    expect(json.kpis.dominant_currency).toBe('INR');
    // Two currencies in play, so the per-currency handling is visibly exercised.
    expect(json.kpis.annualised_spend.USD).toBeGreaterThan(0);
  });

  it('demonstrates every alert rule at once', async () => {
    const env = seededEnv();
    const { json } = await api(env, 'GET', '/api/dashboard?date=2026-09-18');
    const rules = new Set(json.alerts.map((a: any) => a.rule));

    expect(rules).toContain('payment_overdue'); // M365, 17 days late
    expect(rules).toContain('payment_due_soon'); // Zoom, due in a week
    expect(rules).toContain('renewal_upcoming');
    expect(rules).toContain('notice_deadline'); // Figma, 7 days left to cancel
    expect(rules).toContain('missing_data'); // HubSpot has no owner; AWS has no cost
    expect(rules).toContain('seats_underused'); // Clockify, 12 idle seats
  });

  it('includes a cancellation window that has already closed', async () => {
    const env = seededEnv();
    const { json } = await api(env, 'GET', '/api/dashboard?date=2026-09-18');

    const closed = json.alerts.find(
      (a: any) => a.rule === 'notice_deadline' && a.dedupe_key.includes(':passed'),
    );
    expect(closed?.tool_name).toBe('Canva Teams');
  });

  it('keeps a full payment history for tools that were cancelled', async () => {
    const env = seededEnv();
    const { json } = await api(env, 'GET', '/api/dashboard/history');

    const dropbox = json.archived.find((a: any) => a.tool.name === 'Dropbox Business');
    expect(dropbox).toBeTruthy();
    expect(dropbox.lifetime_paid.amount).toBeGreaterThan(0);
  });

  it('gives the spend chart a year of real history to draw', async () => {
    const env = seededEnv();
    const { json } = await api(env, 'GET', '/api/dashboard?date=2026-09-18');
    expect(json.paid_by_month.length).toBeGreaterThanOrEqual(6);
  });

  it('would send a reminder run that is worth reading', async () => {
    const env = seededEnv();
    const { json } = await api(env, 'GET', '/api/reminders/dry-run?date=2026-09-18');

    expect(json.dry_run).toBe(true);
    const consoleChannel = json.alert_dispatch.channels.find((c: any) => c.channel === 'console');
    expect(consoleChannel.new_alerts).toBeGreaterThan(3);
  });
});
