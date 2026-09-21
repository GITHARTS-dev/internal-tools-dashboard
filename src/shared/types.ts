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
  /** Set when this cost is part of running one of our own products. */
  internal_product_id: string | null;
  created_at: string;
  updated_at: string;
}

export type InternalProductStatus = 'live' | 'building' | 'retired';

/**
 * One of the company's own products. Its running cost is not stored on it. It
 * has two parts, both computed elsewhere: the fixed subscriptions attributed to
 * it (hosting plans, domains) and the usage-based costs recorded month by month
 * (see ProductCost), which vary too much to be a price times a billing cycle.
 */
export interface InternalProduct {
  id: string;
  name: string;
  description: string | null;
  status: InternalProductStatus;
  owner_name: string | null;
  owner_email: string | null;
  launched_on: IsoDate | null;
  retired_on: IsoDate | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What one of our own products actually cost in one month, for one provider.
 *
 * Recorded, not derived: usage-based cloud spend differs every month, so it is
 * the amount that was really billed rather than a list price times a cycle.
 */
export interface ProductCost {
  id: string;
  product_id: string;
  /** 'YYYY-MM' */
  month: string;
  /** Free text -- AWS, Supabase, a domain registrar. Unique per month, case-insensitively. */
  provider: string;
  /** Minor units. */
  amount: number;
  currency: string;
  /** 'manual' today; reserved so a later import can be told apart from a typed figure. */
  source: 'manual' | 'aws';
  note: string | null;
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
  /** Currency any combined total is expressed in. */
  reporting_currency: string;
  /** Whether the daily job may fetch fresh ECB rates on its own. */
  fx_auto_refresh: boolean;
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
  reporting_currency: 'INR',
  fx_auto_refresh: true,
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
  | 'costs_missing'
  | 'seats_underused';

export type Severity = 'critical' | 'warning' | 'info';

export interface Alert {
  rule: AlertRule;
  severity: Severity;
  /** Null for an alert about one of our own products rather than a tool. */
  tool_id: string | null;
  /** Set for an alert about one of our own products; null for a tool. */
  product_id: string | null;
  /** Whatever the alert is about: a tool's name, or a product's. */
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

// ---------------------------------------------------------------------------
// The CEO view: one currency, stated assumptions
// ---------------------------------------------------------------------------

/** Running cost of one of our own products, rolled up from its tools. */
export interface InternalProductCost {
  product: InternalProduct;
  tool_count: number;
  /**
   * The fixed part: subscriptions attributed to this product, per currency and
   * before conversion. Usage costs are not here -- they are recorded per month
   * and only exist in converted form.
   */
  monthly: Record<string, number>;
  annual: Record<string, number>;
  /** Fixed subscriptions only, converted. Null when rates were missing. */
  fixed_monthly_reported: number | null;
  fixed_annual_reported: number | null;
  /**
   * Usage-based costs, as a recent monthly average and that average x 12.
   * Null when no month in the window has been entered, which is "unknown", not
   * "free".
   */
  usage_monthly_reported: number | null;
  usage_annual_reported: number | null;
  /** How many of the last three complete months the average is over. */
  usage_months_counted: number;
  /** The most recent month with any entry, complete or not. */
  last_cost_month: string | null;
  /**
   * True when last month's costs are overdue to be entered. The same definition
   * the reminder uses, so the flag on screen and the message in Teams agree.
   */
  cost_entry_due: boolean;
  /** Fixed + usage. What the dashboard shows for this product. */
  monthly_reported: number | null;
  annual_reported: number | null;
}

/** A ranked line in one of the concentration charts. */
export interface RankedSpend {
  id: string;
  label: string;
  sublabel: string | null;
  /** Annualised, converted into the reporting currency. */
  annual_reported: number;
  /** The untouched figure, so the original currency stays visible. */
  amount: number | null;
  currency: string;
}

/**
 * Spend over the last two complete years, for the trend.
 *
 * The current month is deliberately excluded: it is always partial, and a
 * half-finished month plotted beside complete ones reads as a collapse in
 * spending that has not happened.
 */
export interface PeriodComparison {
  /** The 12 complete months ending last month. */
  trailing_12: number | null;
  /** The 12 complete months before those. */
  previous_12: number | null;
  /** Percentage change between them; null when there is no base to compare. */
  change_pct: number | null;
  /** First and last month of the trailing window, for labelling. */
  from: string | null;
  to: string | null;
}

/**
 * Everything the CEO summary shows, with the conversion made explicit.
 *
 * `gaps` is not an error channel. It is the list of amounts that could not be
 * converted and are therefore absent from the totals, shown on screen so the
 * headline number is never quietly wrong.
 */
export interface CeoSummary {
  today: IsoDate;
  /** The most recent month that has fully ended: the one whose costs should be in by now. */
  latest_complete_month: string;
  reporting_currency: string;
  /** Bought SaaS: tools not attributed to one of our own products. */
  subscriptions: {
    tool_count: number;
    monthly_reported: number | null;
    annual_reported: number | null;
  };
  /** Our own products' running cost. */
  internal: {
    product_count: number;
    tool_count: number;
    /** Fixed subscriptions + usage. */
    monthly_reported: number | null;
    annual_reported: number | null;
    /** The usage-based part of that, so the screen can say how much of it varies. */
    usage_annual_reported: number | null;
  };
  products: InternalProductCost[];
  total_monthly_reported: number | null;
  total_annual_reported: number | null;
  /** Actually-paid spend by year, from the ledger, at each month's own rate. */
  paid_by_year: Array<{ year: string; amount: number }>;
  /** Actually-paid spend per month, converted, for the trend. */
  paid_by_month: Array<{ month: string; amount: number }>;
  /** Is spending rising or falling, on complete months only. */
  comparison: PeriodComparison;
  /** The costliest subscriptions, biggest first. */
  top_tools: RankedSpend[];
  /** Annual spend per category, biggest first. */
  by_category: RankedSpend[];
  /**
   * Annual value of seats paid for but not used, converted. The one number on
   * this page that names money already being wasted.
   */
  idle_seat_cost: number | null;
  idle_seat_count: number;
  /** Amounts left out of the totals because no rate covered them. */
  gaps: Array<{ currency: string; month: string | null; count: number }>;
  /** Months whose ECB rates the totals used. */
  rate_months: string[];
  fx_available: boolean;
}

/** How much is stored, and how much of it is the built-in demo data. */
export interface DataStatus {
  tools: number;
  payments: number;
  demo_tools: number;
  own_tools: number;
}
