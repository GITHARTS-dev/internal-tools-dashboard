import { DEFAULT_SETTINGS } from '../src/shared/types';
import type { AppSettings, Payment, Tool } from '../src/shared/types';

export function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 't1',
    name: 'Canva',
    vendor: 'Canva Pty Ltd',
    category: 'Design',
    status: 'active',
    owner_name: 'Priya',
    owner_email: 'priya@example.com',
    department: 'Marketing',
    billing_cycle: 'annual',
    cost_amount: 1_499_00,
    currency: 'INR',
    seats_purchased: 5,
    seats_used: 5,
    renewal_date: '2026-10-15',
    auto_renew: true,
    cancellation_notice_days: 0,
    account_ref: null,
    billing_email: null,
    payment_method: 'HDFC corporate card',
    vendor_url: 'https://www.canva.com',
    notes: null,
    started_on: '2024-10-15',
    cancelled_on: null,
    internal_product_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    ...overrides,
  };
}

export function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: 'p1',
    tool_id: 't1',
    period_start: '2026-10-15',
    period_end: '2027-10-14',
    due_date: '2026-10-15',
    amount: 1_499_00,
    currency: 'INR',
    status: 'due',
    paid_on: null,
    paid_by: null,
    invoice_ref: null,
    invoice_url: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}
