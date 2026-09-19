/**
 * Generates seed/dev-seed.sql: a realistic portfolio of tools and a year of
 * payment history, anchored to a fixed "today" so the dashboard always shows
 * the same interesting mix -- something overdue, something due this week, a
 * cancellation deadline about to close, idle seats, incomplete records, and
 * cancelled tools whose history survives.
 *
 * Deliberately NOT a numbered migration: seed data must never run against a
 * real deployment. Apply it explicitly with `npm run seed:local`.
 *
 *   node scripts/generate-seed.mjs > seed/dev-seed.sql
 */

const TODAY = '2026-09-18';
const STAMP = '2026-09-18T04:00:00.000Z';

const q = (v) =>
  v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const n = (v) => (v === null || v === undefined ? 'NULL' : String(v));

function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  const idx = m - 1 + months;
  const ty = y + Math.floor(idx / 12);
  const tm = ((idx % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = String(Math.min(d, last)).padStart(2, '0');
  return `${ty}-${String(tm + 1).padStart(2, '0')}-${day}`;
}

const cycleMonths = { monthly: 1, quarterly: 3, annual: 12 };

/** id is stable so re-seeding replaces rather than duplicates. */
const tools = [
  {
    id: 'seed-m365', name: 'Microsoft 365 Business Standard', vendor: 'Microsoft',
    category: 'Productivity', status: 'active', owner_name: 'Ravi Kumar',
    owner_email: 'ravi@example.com', department: 'IT', billing_cycle: 'monthly',
    cost_amount: 1375000, currency: 'INR', seats_purchased: 25, seats_used: 22,
    renewal_date: '2026-10-01', auto_renew: 1, cancellation_notice_days: 0,
    account_ref: 'MS-88213', billing_email: 'accounts@example.com',
    payment_method: 'HDFC corporate card', vendor_url: 'https://www.microsoft.com/microsoft-365',
    started_on: '2023-04-01', notes: 'Covers email, Teams and Office apps for the whole company.',
    history: 14,
  },
  {
    id: 'seed-canva', name: 'Canva Teams', vendor: 'Canva', category: 'Design',
    status: 'active', owner_name: 'Priya Nair', owner_email: 'priya@example.com',
    department: 'Marketing', billing_cycle: 'annual', cost_amount: 1499000,
    currency: 'INR', seats_purchased: 5, seats_used: 4,
    // 22 days out with 30 days' notice: the cancellation window has closed.
    renewal_date: '2026-10-10', auto_renew: 1, cancellation_notice_days: 30,
    account_ref: 'CANVA-4821', billing_email: 'accounts@example.com',
    payment_method: 'HDFC corporate card', vendor_url: 'https://www.canva.com',
    started_on: '2024-10-10', notes: 'Shared between design and marketing.',
    history: 2,
  },
  {
    id: 'seed-clockify', name: 'Clockify Pro', vendor: 'COING', category: 'Time tracking',
    status: 'active', owner_name: 'Anita Desai', owner_email: 'anita@example.com',
    department: 'Operations', billing_cycle: 'monthly', cost_amount: 350000,
    currency: 'INR', seats_purchased: 30, seats_used: 18,
    renewal_date: '2026-10-01', auto_renew: 1, cancellation_notice_days: 0,
    account_ref: 'CLK-2210', billing_email: 'accounts@example.com',
    payment_method: 'ICICI current account', vendor_url: 'https://clockify.me',
    started_on: '2024-01-15', notes: 'Twelve seats have never been assigned.',
    history: 14,
  },
  {
    id: 'seed-zoom', name: 'Zoom Workplace Pro', vendor: 'Zoom', category: 'Communication',
    status: 'active', owner_name: 'Ravi Kumar', owner_email: 'ravi@example.com',
    department: 'IT', billing_cycle: 'annual', cost_amount: 2240000, currency: 'INR',
    seats_purchased: 10, seats_used: 6, renewal_date: '2026-09-25', auto_renew: 1,
    cancellation_notice_days: 0, account_ref: 'ZM-71542',
    billing_email: 'accounts@example.com', payment_method: 'HDFC corporate card',
    vendor_url: 'https://zoom.us', started_on: '2023-09-25',
    notes: 'Renews next week.', history: 3,
  },
  {
    id: 'seed-adobe', name: 'Adobe Creative Cloud', vendor: 'Adobe', category: 'Design',
    status: 'active', owner_name: 'Priya Nair', owner_email: 'priya@example.com',
    department: 'Marketing', billing_cycle: 'annual', cost_amount: 10500000,
    currency: 'INR', seats_purchased: 3, seats_used: 3, renewal_date: '2026-11-20',
    auto_renew: 1, cancellation_notice_days: 14, account_ref: 'ADB-30291',
    billing_email: 'accounts@example.com', payment_method: 'HDFC corporate card',
    vendor_url: 'https://www.adobe.com', started_on: '2022-11-20',
    notes: 'Our most expensive single subscription.', history: 4,
  },
  {
    id: 'seed-figma', name: 'Figma Organization', vendor: 'Figma', category: 'Design',
    status: 'active', owner_name: 'Dev Sharma', owner_email: 'dev@example.com',
    department: 'Product', billing_cycle: 'annual', cost_amount: 54000,
    currency: 'USD', seats_purchased: 12, seats_used: 9,
    // Notice deadline is 2026-09-25: seven days left to decide.
    renewal_date: '2026-10-25', auto_renew: 1, cancellation_notice_days: 30,
    account_ref: 'FIG-9931', billing_email: 'accounts@example.com',
    payment_method: 'Amex (USD)', vendor_url: 'https://www.figma.com',
    started_on: '2024-10-25', notes: 'Billed in US dollars.', history: 2,
  },
  {
    id: 'seed-slack', name: 'Slack Pro', vendor: 'Salesforce', category: 'Communication',
    status: 'active', owner_name: 'Anita Desai', owner_email: 'anita@example.com',
    department: 'Operations', billing_cycle: 'annual', cost_amount: 8640000,
    currency: 'INR', seats_purchased: 45, seats_used: 41, renewal_date: '2027-02-01',
    auto_renew: 1, cancellation_notice_days: 0, account_ref: 'SLK-1180',
    billing_email: 'accounts@example.com', payment_method: 'ICICI current account',
    vendor_url: 'https://slack.com', started_on: '2023-02-01', notes: null, history: 3,
  },
  {
    id: 'seed-github', name: 'GitHub Team', vendor: 'GitHub', category: 'Engineering',
    status: 'active', owner_name: 'Dev Sharma', owner_email: 'dev@example.com',
    department: 'Engineering', billing_cycle: 'monthly', cost_amount: 320000,
    currency: 'INR', seats_purchased: 15, seats_used: 15, renewal_date: '2026-10-08',
    auto_renew: 1, cancellation_notice_days: 0, account_ref: 'GH-55120',
    billing_email: 'accounts@example.com', payment_method: 'HDFC corporate card',
    vendor_url: 'https://github.com', started_on: '2023-06-08', notes: null, history: 14,
  },
  {
    id: 'seed-notion', name: 'Notion Plus', vendor: 'Notion Labs', category: 'Productivity',
    status: 'active', owner_name: 'Anita Desai', owner_email: 'anita@example.com',
    department: 'Operations', billing_cycle: 'annual', cost_amount: 9600000,
    currency: 'INR', seats_purchased: 20, seats_used: 11, renewal_date: '2027-01-15',
    auto_renew: 1, cancellation_notice_days: 0, account_ref: 'NTN-7741',
    billing_email: 'accounts@example.com', payment_method: 'ICICI current account',
    vendor_url: 'https://www.notion.so', started_on: '2024-01-15',
    notes: 'Nine seats idle since the restructure.', history: 3,
  },
  {
    id: 'seed-hubspot', name: 'HubSpot Starter', vendor: 'HubSpot', category: 'Sales & CRM',
    status: 'active',
    // Deliberately incomplete: this is what an unowned record looks like.
    owner_name: null, owner_email: null, department: 'Sales', billing_cycle: 'monthly',
    cost_amount: 690000, currency: 'INR', seats_purchased: 5, seats_used: 5,
    renewal_date: '2026-10-05', auto_renew: 1, cancellation_notice_days: 0,
    account_ref: null, billing_email: null, payment_method: null,
    vendor_url: 'https://www.hubspot.com', started_on: '2025-04-05',
    notes: 'Nobody is sure who owns this one.', history: 12,
  },
  {
    id: 'seed-aws', name: 'Amazon Web Services', vendor: 'Amazon', category: 'Infrastructure',
    status: 'active', owner_name: 'Dev Sharma', owner_email: 'dev@example.com',
    department: 'Engineering', billing_cycle: 'monthly',
    // Usage-based, so no fixed cost: another kind of incomplete record.
    cost_amount: null, currency: 'INR', seats_purchased: null, seats_used: null,
    renewal_date: null, auto_renew: 1, cancellation_notice_days: 0,
    account_ref: 'AWS-4410-8827', billing_email: 'accounts@example.com',
    payment_method: 'HDFC corporate card', vendor_url: 'https://aws.amazon.com',
    started_on: '2022-08-01', notes: 'Usage-based; the bill varies every month.',
    history: 0,
  },
  {
    id: 'seed-grammarly', name: 'Grammarly Business', vendor: 'Grammarly',
    category: 'Productivity', status: 'active', owner_name: 'Priya Nair',
    owner_email: 'priya@example.com', department: 'Marketing', billing_cycle: 'annual',
    cost_amount: 2880000, currency: 'INR', seats_purchased: 8, seats_used: 3,
    renewal_date: '2027-03-01', auto_renew: 1, cancellation_notice_days: 0,
    account_ref: 'GRM-2093', billing_email: 'accounts@example.com',
    payment_method: 'HDFC corporate card', vendor_url: 'https://www.grammarly.com',
    started_on: '2025-03-01', notes: null, history: 2,
  },
  {
    id: 'seed-zoho', name: 'Zoho Books', vendor: 'Zoho', category: 'Finance & Accounting',
    status: 'active', owner_name: 'Meera Iyer', owner_email: 'meera@example.com',
    department: 'Finance', billing_cycle: 'annual', cost_amount: 1790000,
    currency: 'INR', seats_purchased: 4, seats_used: 4, renewal_date: '2026-12-01',
    auto_renew: 1, cancellation_notice_days: 0, account_ref: 'ZB-6612',
    billing_email: 'accounts@example.com', payment_method: 'ICICI current account',
    vendor_url: 'https://www.zoho.com/books', started_on: '2023-12-01',
    notes: null, history: 3,
  },
  {
    id: 'seed-atlassian', name: 'Jira Standard', vendor: 'Atlassian', category: 'Engineering',
    status: 'trial', owner_name: 'Dev Sharma', owner_email: 'dev@example.com',
    department: 'Engineering', billing_cycle: 'monthly', cost_amount: 450000,
    currency: 'INR', seats_purchased: 20, seats_used: 7, renewal_date: '2026-09-30',
    auto_renew: 1, cancellation_notice_days: 0, account_ref: 'ATL-1123',
    billing_email: null, payment_method: null, vendor_url: 'https://www.atlassian.com',
    started_on: '2026-08-30', notes: 'Trial ends this month -- decide before it converts.',
    history: 0,
  },
  {
    id: 'seed-dropbox', name: 'Dropbox Business', vendor: 'Dropbox', category: 'Infrastructure',
    status: 'cancelled', owner_name: 'Ravi Kumar', owner_email: 'ravi@example.com',
    department: 'IT', billing_cycle: 'annual', cost_amount: 4500000, currency: 'INR',
    seats_purchased: 10, seats_used: 2, renewal_date: '2026-05-01', auto_renew: 0,
    cancellation_notice_days: 0, account_ref: 'DBX-3345',
    billing_email: 'accounts@example.com', payment_method: 'HDFC corporate card',
    vendor_url: 'https://www.dropbox.com', started_on: '2022-05-01',
    cancelled_on: '2026-04-30', notes: 'Replaced by SharePoint, which we already pay for.',
    history: 4,
  },
  {
    id: 'seed-asana', name: 'Asana Premium', vendor: 'Asana', category: 'Productivity',
    status: 'cancelled', owner_name: 'Anita Desai', owner_email: 'anita@example.com',
    department: 'Operations', billing_cycle: 'annual', cost_amount: 7200000,
    currency: 'INR', seats_purchased: 25, seats_used: 9, renewal_date: '2025-12-01',
    auto_renew: 0, cancellation_notice_days: 0, account_ref: 'ASN-9021',
    billing_email: 'accounts@example.com', payment_method: 'ICICI current account',
    vendor_url: 'https://asana.com', started_on: '2023-12-01', cancelled_on: '2025-11-15',
    notes: 'Consolidated into Notion.', history: 2,
  },
  {
    id: 'seed-lucid', name: 'Lucidchart Team', vendor: 'Lucid', category: 'Design',
    status: 'expired', owner_name: null, owner_email: null, department: 'Product',
    billing_cycle: 'annual', cost_amount: 1200000, currency: 'INR',
    seats_purchased: 5, seats_used: 1, renewal_date: '2026-02-28', auto_renew: 0,
    cancellation_notice_days: 0, account_ref: null, billing_email: null,
    payment_method: null, vendor_url: 'https://www.lucidchart.com',
    started_on: '2024-02-28', cancelled_on: '2026-02-28',
    notes: 'Lapsed because nobody renewed it in time.', history: 2,
  },
];

const lines = [
  '-- Development seed data. Generated by scripts/generate-seed.mjs -- do not edit by hand.',
  `-- Anchored to ${TODAY} so the dashboard always shows the same worked example.`,
  '--',
  '-- NOT a migration: this must never run against a real deployment.',
  '-- Apply it with: npm run seed:local',
  '',
  'DELETE FROM notification_log;',
  'DELETE FROM audit_log;',
  'DELETE FROM documents;',
  'DELETE FROM payments;',
  'DELETE FROM tools;',
  '',
];

const toolCols = [
  'id', 'name', 'vendor', 'category', 'status', 'owner_name', 'owner_email', 'department',
  'billing_cycle', 'cost_amount', 'currency', 'seats_purchased', 'seats_used', 'renewal_date',
  'auto_renew', 'cancellation_notice_days', 'account_ref', 'billing_email', 'payment_method',
  'vendor_url', 'notes', 'started_on', 'cancelled_on', 'created_at', 'updated_at',
];

for (const t of tools) {
  const values = toolCols.map((col) => {
    if (col === 'created_at' || col === 'updated_at') return q(STAMP);
    const v = t[col] ?? null;
    return ['cost_amount', 'seats_purchased', 'seats_used', 'auto_renew', 'cancellation_notice_days'].includes(col)
      ? n(v)
      : q(v);
  });
  lines.push(`INSERT INTO tools (${toolCols.join(', ')}) VALUES (${values.join(', ')});`);
}
lines.push('');

const paymentCols = [
  'id', 'tool_id', 'period_start', 'period_end', 'due_date', 'amount', 'currency',
  'status', 'paid_on', 'paid_by', 'invoice_ref', 'notes', 'created_at', 'updated_at',
];

let paymentSeq = 0;
function payment(tool, dueDate, status, paidOn, amount) {
  const months = cycleMonths[tool.billing_cycle] ?? 1;
  const periodEnd = addMonths(dueDate, months);
  const id = `seed-pay-${String(++paymentSeq).padStart(4, '0')}`;
  const values = [
    q(id), q(tool.id), q(dueDate), q(periodEnd), q(dueDate),
    n(amount ?? tool.cost_amount), q(tool.currency), q(status),
    q(paidOn), q(status === 'paid' ? 'Meera Iyer' : null),
    q(status === 'paid' ? `INV-${dueDate.replace(/-/g, '').slice(0, 6)}-${String(paymentSeq).padStart(3, '0')}` : null),
    'NULL', q(STAMP), q(STAMP),
  ];
  lines.push(`INSERT INTO payments (${paymentCols.join(', ')}) VALUES (${values.join(', ')});`);
}

// The current, unsettled state -- what the dashboard needs to shout about.
const openPayments = [
  ['seed-m365', '2026-09-01'], // overdue by 17 days
  ['seed-zoom', '2026-09-25'], // due in a week
  ['seed-clockify', '2026-10-01'],
  ['seed-github', '2026-10-08'],
  ['seed-canva', '2026-10-10'],
];
const isOpen = (tool, due) => openPayments.some(([id, d]) => id === tool.id && d === due);

for (const tool of tools) {
  if (!tool.history || tool.cost_amount === null) continue;
  const months = cycleMonths[tool.billing_cycle] ?? 1;

  // Walk backwards from the next renewal, marking past periods paid.
  for (let i = tool.history; i >= 1; i--) {
    const due = addMonths(tool.renewal_date, -i * months);
    if (tool.cancelled_on && due > tool.cancelled_on) continue;
    // A period that is still open must not also appear as paid, or it shows up
    // twice and marking one row paid appears to change nothing.
    if (isOpen(tool, due)) continue;
    // Bills are usually settled a few days before they are due.
    const paidOn = addMonths(due, 0);
    payment(tool, due, 'paid', paidOn, tool.cost_amount);
  }
}

for (const [id, due] of openPayments) {
  const tool = tools.find((t) => t.id === id);
  payment(tool, due, 'due', null, tool.cost_amount);
}

lines.push('');
lines.push(
  `INSERT INTO audit_log (id, entity, entity_id, action, actor, summary, diff_json, created_at) VALUES` +
    ` ('seed-audit-1', 'tool', 'seed-dropbox', 'archive', 'ravi@example.com', 'Marked Dropbox Business cancelled as of 2026-04-30', NULL, '2026-04-30T09:12:00.000Z'),` +
    ` ('seed-audit-2', 'tool', 'seed-clockify', 'update', 'anita@example.com', 'Updated seats_used', '[{"field":"seats_used","from":24,"to":18}]', '2026-08-02T06:40:00.000Z'),` +
    ` ('seed-audit-3', 'tool', 'seed-hubspot', 'create', 'web', 'Added HubSpot Starter', NULL, '2025-04-05T11:05:00.000Z');`,
);
lines.push('');

process.stdout.write(lines.join('\n'));
