/** Domain types as they exist after leaving the repository layer. */

import type { IsoDate, BillingCycle } from './dates';
import type {
  TOOL_STATUSES,
  PAYMENT_STATUSES,
  DOCUMENT_KINDS,
} from './schema';

export type ToolStatus = (typeof TOOL_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type { BillingCycle, IsoDate };

export interface Tool {
  id: string;
  name: string;
  vendor: string | null;
  category: string;
  status: ToolStatus;
  owner_name: string | null;
  owner_email: string | null;
  department: string | null;
  billing_cycle: BillingCycle;
  /** Minor units. */
  cost_amount: number | null;
  currency: string;
  seats_purchased: number | null;
  seats_used: number | null;
  renewal_date: IsoDate | null;
  /** Stored as 0/1 in SQLite, surfaced as a boolean everywhere else. */
  auto_renew: boolean;
  cancellation_notice_days: number;
  account_ref: string | null;
  billing_email: string | null;
  payment_method: string | null;
  vendor_url: string | null;
  notes: string | null;
  started_on: IsoDate | null;
  cancelled_on: IsoDate | null;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  tool_id: string;
  period_start: IsoDate | null;
  period_end: IsoDate | null;
  due_date: IsoDate;
  amount: number;
  currency: string;
  status: PaymentStatus;
  paid_on: IsoDate | null;
  paid_by: string | null;
  invoice_ref: string | null;
  invoice_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ToolDocument {
  id: string;
  tool_id: string;
  kind: DocumentKind;
  title: string;
  external_url: string | null;
  file_key: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  entity: string;
  entity_id: string;
  action: 'create' | 'update' | 'archive' | 'delete' | 'restore';
  actor: string;
  summary: string | null;
  diff_json: string | null;
  created_at: string;
}

export interface NotificationEntry {
  id: string;
  dedupe_key: string;
  tool_id: string | null;
  payment_id: string | null;
  rule: string;
  channel: string;
  target: string | null;
  severity: string | null;
  status: 'sent' | 'failed' | 'skipped';
  detail: string | null;
  sent_at: string;
}

export interface AppSettings {
  timezone: string;
  default_currency: string;
  renewal_lead_days: number[];
  payment_lead_days: number[];
  notice_lead_days: number[];
  seat_underuse_ratio: number;
  /** ISO weekday, 1 = Monday. */
  digest_weekday: number;
  digest_horizon_days: number;
  teams_webhook_url: string;
  email_from: string;
  email_to: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  timezone: 'Asia/Kolkata',
  default_currency: 'INR',
  renewal_lead_days: [60, 30, 14, 7, 3, 1],
  payment_lead_days: [7, 3, 1],
  notice_lead_days: [14, 7, 3, 1],
  seat_underuse_ratio: 0.7,
  digest_weekday: 1,
  digest_horizon_days: 45,
  teams_webhook_url: '',
  email_from: '',
  email_to: '',
};

// ---------------------------------------------------------------------------
// Computed types (never stored)
// ---------------------------------------------------------------------------

export type AlertRule =
  | 'payment_overdue'
  | 'payment_due_soon'
  | 'renewal_upcoming'
  | 'notice_deadline'
  | 'missing_data'
  | 'seats_underused';

export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  rule: AlertRule;
  severity: Severity;
  tool_id: string;
  tool_name: string;
  payment_id: string | null;
  title: string;
  detail: string;
  /** The date the alert is about: a due date, renewal date or notice deadline. */
  date: IsoDate | null;
  /** Days from today to `date`. Negative means it has already passed. */
  days_until: number | null;
  amount: number | null;
  currency: string | null;
  owner_name: string | null;
  owner_email: string | null;
  /**
   * Stable identity for "this exact alert, at this exact lead step".
   * The notification log's UNIQUE constraint on this is what stops a person
   * being told the same thing every morning for sixty days.
   */
  dedupe_key: string;
}

export interface KpiSummary {
  active_tools: number;
  trial_tools: number;
  cancelled_tools: number;
  /** Per-currency, since v1 does no FX conversion. */
  monthly_run_rate: Record<string, number>;
  annualised_spend: Record<string, number>;
  wasted_seat_cost: Record<string, number>;
  dominant_currency: string | null;
  seats_purchased: number;
  seats_used: number;
  overdue_count: number;
  due_soon_count: number;
  paid_this_year: Record<string, number>;
}

export interface CategorySpend {
  category: string;
  currency: string;
  monthly: number;
  annual: number;
  tool_count: number;
}

export interface RenewalTimelineEntry {
  tool_id: string;
  tool_name: string;
  date: IsoDate;
  days_until: number;
  amount: number | null;
  currency: string;
  billing_cycle: BillingCycle;
  auto_renew: boolean;
}

export interface DashboardData {
  today: IsoDate;
  kpis: KpiSummary;
  alerts: Alert[];
  category_spend: CategorySpend[];
  renewal_timeline: RenewalTimelineEntry[];
}
