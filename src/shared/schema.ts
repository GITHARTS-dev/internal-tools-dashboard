/**
 * The single definition of what a valid record looks like.
 *
 * Both the API and the UI forms validate against these schemas, so the
 * browser can never submit something the server would reject for a different
 * reason -- and an import CSV is held to exactly the same standard as a
 * hand-typed form.
 */

import { z } from 'zod';
import { isIsoDate } from './dates';
import { isYearMonth } from './fx';

export const TOOL_STATUSES = ['active', 'trial', 'cancelled', 'expired'] as const;
export const BILLING_CYCLES = ['monthly', 'quarterly', 'annual', 'one_time', 'custom'] as const;
export const PAYMENT_STATUSES = ['due', 'paid', 'waived'] as const;
export const DOCUMENT_KINDS = ['contract', 'invoice', 'receipt', 'other'] as const;

/** Suggested, not enforced -- teams always have a category we did not predict. */
export const CATEGORY_SUGGESTIONS = [
  'Design',
  'Productivity',
  'Engineering',
  'Communication',
  'Time tracking',
  'Marketing',
  'Sales & CRM',
  'Finance & Accounting',
  'HR & Recruiting',
  'Security',
  'Infrastructure',
  'Analytics',
  'AI',
  'Other',
] as const;

export const CURRENCY_SUGGESTIONS = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'] as const;

/** Empty string from an untouched form field means "not set", not "". */
const optText = (max = 300) =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().max(max).nullable(),
  );

const optDate = () =>
  z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z
      .string()
      .nullable()
      .refine((v) => v === null || isIsoDate(v), {
        message: 'Use a real calendar date in YYYY-MM-DD form',
      }),
  );

const optInt = (min: number, max: number) =>
  z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? null : Number(v)),
    z.number().int().min(min).max(max).nullable(),
  );

const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as INR or USD')
  .default('INR');

export const toolCreateSchema = z.object({
  name: z.string().trim().min(1, 'Every tool needs a name').max(120),
  vendor: optText(120),
  category: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? 'Other' : v),
    z.string().trim().max(60),
  ),
  status: z.enum(TOOL_STATUSES).default('active'),

  owner_name: optText(120),
  owner_email: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().toLowerCase().email('That does not look like an email address').nullable(),
  ),
  department: optText(120),

  billing_cycle: z.enum(BILLING_CYCLES).default('monthly'),
  // Minor units (paise/cents). The UI converts; the API never sees a float.
  cost_amount: optInt(0, 1_000_000_000_00),
  currency,

  seats_purchased: optInt(0, 1_000_000),
  seats_used: optInt(0, 1_000_000),

  renewal_date: optDate(),
  auto_renew: z.preprocess((v) => (v === undefined ? true : v), z.coerce.boolean()),
  cancellation_notice_days: z.preprocess(
    (v) => (v === '' || v === undefined || v === null ? 0 : Number(v)),
    z.number().int().min(0).max(365),
  ),

  account_ref: optText(120),
  billing_email: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().toLowerCase().email('That does not look like an email address').nullable(),
  ),
  payment_method: optText(120),
  vendor_url: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().url('Include the full URL, starting with https://').max(500).nullable(),
  ),
  notes: optText(4000),

  started_on: optDate(),
  cancelled_on: optDate(),

  /** Attribution to one of our own products; null means bought SaaS. */
  internal_product_id: optText(60),
});

export const toolUpdateSchema = toolCreateSchema.partial();

export const INTERNAL_PRODUCT_STATUSES = ['live', 'building', 'retired'] as const;

export const internalProductCreateSchema = z.object({
  name: z.string().trim().min(1, 'Every product needs a name').max(120),
  description: optText(500),
  status: z.enum(INTERNAL_PRODUCT_STATUSES).default('live'),
  owner_name: optText(120),
  owner_email: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().toLowerCase().email('That does not look like an email address').nullable(),
  ),
  launched_on: optDate(),
  retired_on: optDate(),
  notes: optText(4000),
});

export const internalProductUpdateSchema = internalProductCreateSchema.partial();

/**
 * One month of one provider's cost for a product.
 *
 * Entering the same month and provider again replaces the earlier figure, so
 * this is an upsert payload rather than a create-only one. Amount is minor
 * units: the form converts, the API never sees a float.
 */
export const productCostSchema = z.object({
  month: z
    .string()
    .trim()
    .refine(isYearMonth, 'Use a month such as 2026-08'),
  provider: z.string().trim().min(1, 'Say which provider this is, such as AWS').max(60),
  amount: z.coerce.number().int('Enter a whole number of minor units').min(0, 'A cost cannot be negative'),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as USD')
    // Cloud bills are almost always in dollars, so that is what an unset
    // currency means here, unlike a tool where the company default applies.
    .default('USD'),
  note: optText(300),
});

export const paymentCreateSchema = z.object({
  tool_id: z.string().trim().min(1),
  period_start: optDate(),
  period_end: optDate(),
  due_date: z.string().refine(isIsoDate, 'A payment must have a real due date'),
  amount: z.coerce.number().int().min(0),
  currency,
  status: z.enum(PAYMENT_STATUSES).default('due'),
  paid_on: optDate(),
  paid_by: optText(120),
  invoice_ref: optText(120),
  invoice_url: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().url('Include the full URL').max(500).nullable(),
  ),
  notes: optText(2000),
});

export const paymentUpdateSchema = paymentCreateSchema.partial().omit({ tool_id: true });

export const markPaidSchema = z.object({
  paid_on: optDate(),
  paid_by: optText(120),
  invoice_ref: optText(120),
});

export const documentCreateSchema = z.object({
  tool_id: z.string().trim().min(1),
  kind: z.enum(DOCUMENT_KINDS).default('other'),
  title: z.string().trim().min(1).max(200),
  external_url: z.preprocess(
    (v) => (v === '' || v === undefined ? null : v),
    z.string().trim().url('Include the full URL').max(500).nullable(),
  ),
  file_key: optText(300),
  uploaded_by: optText(120),
});

export const settingsUpdateSchema = z.record(z.string(), z.string());

export type ProductCostInput = z.infer<typeof productCostSchema>;
export type InternalProductCreateInput = z.infer<typeof internalProductCreateSchema>;
export type InternalProductUpdateInput = z.infer<typeof internalProductUpdateSchema>;
export type ToolCreateInput = z.infer<typeof toolCreateSchema>;
export type ToolUpdateInput = z.infer<typeof toolUpdateSchema>;
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;
export type PaymentUpdateInput = z.infer<typeof paymentUpdateSchema>;
export type DocumentCreateInput = z.infer<typeof documentCreateSchema>;
