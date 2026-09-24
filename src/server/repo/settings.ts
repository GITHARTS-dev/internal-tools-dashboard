import { nowIso, type Db } from './db';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types';

/**
 * Settings are stored as text key/value pairs and parsed into a typed object
 * here. Anything malformed falls back to the default rather than throwing:
 * a bad value in one setting must not stop the reminder job from running.
 */

function parseNumberList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return parsed as number[];
    }
  } catch {
    // fall through
  }
  return fallback;
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function getSettings(db: Db): Promise<AppSettings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const raw = Object.fromEntries(results.map((r) => [r.key, r.value])) as Record<string, string>;

  return {
    timezone: raw['timezone'] || DEFAULT_SETTINGS.timezone,
    default_currency: raw['default_currency'] || DEFAULT_SETTINGS.default_currency,
    renewal_lead_days: parseNumberList(raw['renewal_lead_days'], DEFAULT_SETTINGS.renewal_lead_days),
    payment_lead_days: parseNumberList(raw['payment_lead_days'], DEFAULT_SETTINGS.payment_lead_days),
    notice_lead_days: parseNumberList(raw['notice_lead_days'], DEFAULT_SETTINGS.notice_lead_days),
    seat_underuse_ratio: parseNumber(raw['seat_underuse_ratio'], DEFAULT_SETTINGS.seat_underuse_ratio),
    digest_weekday: parseNumber(raw['digest_weekday'], DEFAULT_SETTINGS.digest_weekday),
    digest_horizon_days: parseNumber(raw['digest_horizon_days'], DEFAULT_SETTINGS.digest_horizon_days),
    teams_webhook_url: raw['teams_webhook_url'] ?? '',
    email_from: raw['email_from'] ?? '',
    email_to: raw['email_to'] ?? '',
    reporting_currency:
      (raw['reporting_currency'] || DEFAULT_SETTINGS.reporting_currency).toUpperCase(),
    fx_auto_refresh: raw['fx_auto_refresh'] !== 'false',
    aws_default_product_id: (raw['aws_default_product_id'] ?? '').trim(),
    aws_cost_tag_key: (raw['aws_cost_tag_key'] ?? '').trim(),
  };
}

export async function updateSettings(db: Db, patch: Record<string, string>): Promise<AppSettings> {
  const ts = nowIso();
  const statements = Object.entries(patch).map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, value, ts),
  );
  if (statements.length > 0) await db.batch(statements);
  return getSettings(db);
}
