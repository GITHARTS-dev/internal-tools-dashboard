import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Banner, CurrencySelect, EmptyState, Loading, StatusBadge, useToast } from '../components/ui';
import { SeatMeter } from '../components/Charts';
import { annualisedCost, costPerSeat, formatMoney, parseMoneyInput, toDecimalString, wastedSeatCost } from '../../shared/money';
import { daysBetween, formatDate, relativeDays } from '../../shared/dates';
import { effectiveRenewalDate } from '../../shared/alerts';
import type { Payment, PriceChange, Tool } from '../../shared/types';

const CYCLE_LABEL: Record<string, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual',
  one_time: 'One-off', custom: 'Custom',
};

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PaymentStatusBadge({ payment, today }: { payment: Payment; today: string }) {
  if (payment.status === 'paid') return <Badge tone="good" dot>Paid</Badge>;
  if (payment.status === 'waived') return <Badge tone="info" dot>Waived</Badge>;
  // Overdue is derived here exactly as the alert engine derives it.
  const days = daysBetween(today, payment.due_date);
  if (days < 0) return <Badge tone="critical" dot>Overdue</Badge>;
  return <Badge tone={days <= 7 ? 'warning' : 'info'} dot>Due</Badge>;
}

export default function ToolDetail() {
  const { id = '' } = useParams();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [priceForm, setPriceForm] = useState<PriceFormState | null>(null);

  const { data, error, loading, reload } = useAsync(() => api.tool(id), [id]);
  const today = new Date().toISOString().slice(0, 10);

  if (loading && !data) return <Loading rows={3} />;
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { tool, payments, audit, documents, documents_enabled } = data;
  const priceChanges = data.price_changes ?? [];
  const upcomingChange = priceChanges.find((c) => c.effective_from > today) ?? null;
  const annual = annualisedCost(tool.cost_amount, tool.billing_cycle);
  const perSeat = costPerSeat(tool.cost_amount, tool.seats_purchased);
  const waste = wastedSeatCost(tool.cost_amount, tool.seats_purchased, tool.seats_used);
  const renewalDays = tool.renewal_date ? daysBetween(today, tool.renewal_date) : null;

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      toast(message);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function deleteTool() {
    const ok = window.confirm(
      `Delete ${tool.name}? It moves to Trash, kept for 30 days with the option to restore it, before it is gone for good.`,
    );
    if (ok) act(() => api.deleteTool(tool.id), `${tool.name} moved to Trash.`);
  }

  // The daily job adds each payment in the month it falls due, using the same
  // date the reminders do. Say what it will do next, or why it cannot.
  const nextDue = effectiveRenewalDate(tool, today);
  const live = tool.status === 'active' || tool.status === 'trial';
  const nextAlreadyListed =
    nextDue !== null && payments.some((p) => p.due_date.slice(0, 7) === nextDue.slice(0, 7));
  const scheduleNote = !live || Boolean(tool.deleted_at)
    ? null
    : tool.cost_amount === null
      ? 'Add this tool’s cost so its payments can be added automatically.'
      : !tool.renewal_date
        ? 'Add a renewal date so its payments can be added automatically.'
        : !nextDue
          ? 'The renewal date has passed and this tool does not auto-renew, so no further payments will be added.'
          : nextAlreadyListed
            ? null
            : `The next payment, ${formatMoney(tool.cost_amount, tool.currency)} due ${formatDate(nextDue)}, is added here automatically in the month it falls due.`;

  // Opened from the toolbar, the change starts with the next unpaid bill --
  // usually the one someone is holding the invoice for.
  function openPriceForm(payment?: Payment) {
    const nextUnpaid = [...payments]
      .filter((p) => p.status === 'due' && p.due_date >= today)
      .sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
    const amount = payment?.amount ?? tool.cost_amount;
    const currency = payment?.currency ?? tool.currency;
    setPriceForm({
      effective_from: payment?.due_date ?? nextUnpaid?.due_date ?? nextDue ?? today,
      amount: amount === null ? '' : toDecimalString(amount, currency),
      currency,
      note: '',
    });
  }

  function removePayment(payment: Payment) {
    const ok = window.confirm(
      `Remove the ${formatMoney(payment.amount, payment.currency)} payment due ${formatDate(payment.due_date)}? This cannot be undone.`,
    );
    if (ok) act(() => api.deletePayment(payment.id), 'Payment removed.');
  }

  const trashed = Boolean(tool.deleted_at);

  return (
    <>
      <div className="crumb">
        <Link to="/tools">Tools</Link> / {tool.name}
      </div>

      <div className="toolbar">
        <h1 style={{ fontSize: 20 }}>{tool.name}</h1>
        <StatusBadge status={tool.status} />
        {trashed ? <Badge tone="critical">In trash</Badge> : null}
        <span className="spacer" />
        {trashed ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => act(() => api.undeleteTool(tool.id), `${tool.name} restored from Trash.`)}
          >
            Restore from Trash
          </button>
        ) : (
          <>
            <Link className="btn" to={`/tools/${tool.id}/edit`}>
              Edit
            </Link>
            <button type="button" className="btn" disabled={busy} onClick={() => openPriceForm()}>
              Change price
            </button>
            {tool.status === 'cancelled' || tool.status === 'expired' ? (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => act(() => api.restoreTool(tool.id), `${tool.name} restored to active.`)}
              >
                Restore
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => act(() => api.archiveTool(tool.id), `${tool.name} marked cancelled.`)}
              >
                Mark cancelled
              </button>
            )}
            <button type="button" className="btn danger" disabled={busy} onClick={deleteTool}>
              Delete
            </button>
          </>
        )}
      </div>

      {trashed ? (
        <Banner tone="critical">
          In Trash{tool.deleted_by ? `, deleted by ${tool.deleted_by}` : ''} on{' '}
          {formatDate((tool.deleted_at ?? '').slice(0, 10))}. Restore it, or leave it — it is
          purged for good 30 days after it was deleted. The payment history below is untouched
          either way.
        </Banner>
      ) : tool.status === 'cancelled' ? (
        <Banner tone="info">
          Cancelled on {formatDate(tool.cancelled_on)}. Nothing has been deleted — the payment
          history below is kept so past spend stays answerable.
        </Banner>
      ) : null}

      {tool.auto_renew && tool.cancellation_notice_days > 0 && tool.renewal_date && renewalDays !== null ? (
        <NoticeBanner
          renewalDate={tool.renewal_date}
          noticeDays={tool.cancellation_notice_days}
          today={today}
        />
      ) : null}

      {priceForm && !trashed ? (
        <PriceChangeForm
          tool={tool}
          initial={priceForm}
          busy={busy}
          onCancel={() => setPriceForm(null)}
          onSave={(body) =>
            act(async () => {
              await api.changePrice(tool.id, body);
              setPriceForm(null);
            }, 'Price updated.')
          }
        />
      ) : null}

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>The essentials</h2>
          </div>
          <dl className="detail-grid" style={{ margin: 0 }}>
            <Detail label="Owner">
              {tool.owner_name ?? <span style={{ color: 'var(--critical-text)' }}>Unassigned</span>}
              {tool.owner_email ? <div className="cell-sub">{tool.owner_email}</div> : null}
            </Detail>
            <Detail label="Vendor">{tool.vendor ?? '—'}</Detail>
            <Detail label="Category">{tool.category}</Detail>
            <Detail label="Cost">
              {tool.cost_amount === null ? '—' : formatMoney(tool.cost_amount, tool.currency)}
              <div className="cell-sub">
                {CYCLE_LABEL[tool.billing_cycle]}
                {annual !== null ? ` · ${formatMoney(annual, tool.currency)}/year` : ''}
              </div>
              {upcomingChange ? (
                <div className="cell-sub">
                  {formatMoney(upcomingChange.amount, upcomingChange.currency)} from{' '}
                  {formatDate(upcomingChange.effective_from)}
                </div>
              ) : null}
            </Detail>
            <Detail label="Renews">
              {tool.renewal_date ? formatDate(tool.renewal_date) : '—'}
              {renewalDays !== null ? <div className="cell-sub">{relativeDays(renewalDays)}</div> : null}
            </Detail>
            <Detail label="Auto-renew">{tool.auto_renew ? 'Yes' : 'No'}</Detail>
            <Detail label="Cancellation notice">
              {tool.cancellation_notice_days > 0 ? `${tool.cancellation_notice_days} days` : 'None required'}
            </Detail>
          </dl>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Seats &amp; billing</h2>
          </div>
          <dl className="detail-grid" style={{ margin: 0 }}>
            <Detail label="Seats in use">
              <SeatMeter used={tool.seats_used} purchased={tool.seats_purchased} />
            </Detail>
            <Detail label="Cost per seat">
              {perSeat === null ? '—' : `${formatMoney(perSeat, tool.currency)} per period`}
            </Detail>
            <Detail label="Idle seat cost">
              {waste === null ? (
                '—'
              ) : waste === 0 ? (
                'None — every seat is assigned'
              ) : (
                <span style={{ color: 'var(--critical-text)' }}>
                  {formatMoney(waste, tool.currency)} per period
                </span>
              )}
            </Detail>
            <Detail label="Payment method">{tool.payment_method ?? '—'}</Detail>
            <Detail label="Billing email">{tool.billing_email ?? '—'}</Detail>
            <Detail label="Account reference">{tool.account_ref ?? '—'}</Detail>
            <Detail label="Started">{tool.started_on ? formatDate(tool.started_on) : '—'}</Detail>
            <Detail label="Currency">{tool.currency}</Detail>
          </dl>
          {tool.notes ? (
            <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: 13 }}>{tool.notes}</p>
          ) : null}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Payment history</h2>
          <span className="hint">{payments.length} record{payments.length === 1 ? '' : 's'}</span>
        </div>
        {scheduleNote && payments.length > 0 ? (
          <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: 13 }}>{scheduleNote}</p>
        ) : null}
        {payments.length === 0 ? (
          <EmptyState title="No payments recorded">
            {scheduleNote ?? 'Payments are added here automatically in the month they fall due.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Due</th>
                  <th scope="col">Period</th>
                  <th className="num" scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Paid</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td>{formatDate(payment.due_date)}</td>
                    <td className="cell-sub">
                      {payment.period_start ? `${formatDate(payment.period_start)} – ${formatDate(payment.period_end)}` : '—'}
                    </td>
                    <td className="num">{formatMoney(payment.amount, payment.currency)}</td>
                    <td>
                      <PaymentStatusBadge payment={payment} today={today} />
                    </td>
                    <td>
                      {payment.paid_on ? (
                        <>
                          {formatDate(payment.paid_on)}
                          {payment.paid_by ? <div className="cell-sub">{payment.paid_by}</div> : null}
                        </>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </td>
                    <td className="num">
                      {payment.status === 'due' ? (
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            onClick={() => act(() => api.markPaid(payment.id), 'Marked as paid.')}
                          >
                            Mark paid
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={busy}
                            title="The invoice shows a different amount? Change the price from this bill on."
                            onClick={() => openPriceForm(payment)}
                          >
                            Change price
                          </button>
                          {/* Only unpaid rows: a paid one is a record of money that went out. */}
                          <button
                            type="button"
                            className="btn sm subtle"
                            disabled={busy}
                            onClick={() => removePayment(payment)}
                          >
                            Remove
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {priceChanges.length > 0 ? <PriceHistory changes={priceChanges} today={today} /> : null}

      {documents_enabled ? (
        <section className="card">
          <div className="card-head">
            <h2>Documents</h2>
          </div>
          {documents.length === 0 ? (
            <EmptyState title="Nothing attached yet" />
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {documents.map((doc) => (
                <li key={doc.id} style={{ padding: '4px 0' }}>
                  {doc.external_url ? (
                    <a href={doc.external_url} target="_blank" rel="noreferrer" style={{ color: 'var(--series-1)' }}>
                      {doc.title}
                    </a>
                  ) : (
                    doc.title
                  )}{' '}
                  <span className="cell-sub">({doc.kind})</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Change history</h2>
          <span className="hint">who changed what, and when</span>
        </div>
        {audit.length === 0 ? (
          <EmptyState title="No changes recorded" />
        ) : (
          <div>
            {audit.map((entry) => {
              const changes: Array<{ field: string; from: unknown; to: unknown }> = entry.diff_json
                ? JSON.parse(entry.diff_json)
                : [];
              return (
                <div key={entry.id} className="audit-item">
                  <span className="audit-when">
                    {new Date(entry.created_at).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                  <span className="audit-change">
                    <strong style={{ color: 'var(--text-primary)' }}>{entry.actor}</strong>{' '}
                    {entry.summary ?? entry.action}
                    {changes.length > 0 ? (
                      <div style={{ marginTop: 3 }}>
                        {changes.map((change) => (
                          <div key={change.field}>
                            <code>{change.field}</code>: {String(change.from ?? '—')} → {String(change.to ?? '—')}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

/** Spells out the deadline people actually miss: the last day to cancel. */
function NoticeBanner({
  renewalDate,
  noticeDays,
  today,
}: {
  renewalDate: string;
  noticeDays: number;
  today: string;
}) {
  const deadline = new Date(`${renewalDate}T00:00:00Z`);
  deadline.setUTCDate(deadline.getUTCDate() - noticeDays);
  const deadlineIso = deadline.toISOString().slice(0, 10);
  const daysLeft = daysBetween(today, deadlineIso);

  if (daysLeft < 0) {
    return (
      <Banner tone="warning">
        The {noticeDays}-day cancellation window closed on {formatDate(deadlineIso)}, so this will
        auto-renew on {formatDate(renewalDate)}. Budget for it, or cancel for the period after.
      </Banner>
    );
  }
  if (daysLeft <= 30) {
    return (
      <Banner tone={daysLeft <= 7 ? 'critical' : 'warning'}>
        Last day to cancel without paying for another period is {formatDate(deadlineIso)} —{' '}
        {relativeDays(daysLeft)}.
      </Banner>
    );
  }
  return null;
}

interface PriceFormState {
  effective_from: string;
  /** As typed, in major units. */
  amount: string;
  currency: string;
  note: string;
}

/**
 * Change a tool's price from a date. Bills due from that date use the new
 * price until it changes again; paid bills keep what was paid.
 */
function PriceChangeForm({
  tool,
  initial,
  busy,
  onCancel,
  onSave,
}: {
  tool: Tool;
  initial: PriceFormState;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { amount: number; currency: string; effective_from: string; note: string | null }) => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof PriceFormState>(key: K, value: PriceFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const amount = parseMoneyInput(form.amount, form.currency);
    if (amount === null || amount < 0) {
      setError('Enter the new price, such as 22.00');
      return;
    }
    if (!form.effective_from) {
      setError('Give the date the new price starts');
      return;
    }
    setError(null);
    onSave({
      amount,
      currency: form.currency,
      effective_from: form.effective_from,
      note: form.note.trim() || null,
    });
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Change {tool.name}’s price</h2>
        <span className="hint">
          now {tool.cost_amount === null ? 'not set' : formatMoney(tool.cost_amount, tool.currency)}
        </span>
      </div>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="price-amount">New price per billing period</label>
            <input
              id="price-amount"
              inputMode="decimal"
              value={form.amount}
              onChange={(e) => set('amount', e.target.value)}
              aria-invalid={Boolean(error)}
              placeholder="22.00"
              autoFocus
            />
            {error ? <span className="error">{error}</span> : null}
          </div>
          <div className="field">
            <label htmlFor="price-currency">Currency</label>
            <CurrencySelect id="price-currency" value={form.currency} onChange={(c) => set('currency', c)} />
          </div>
          <div className="field">
            <label htmlFor="price-from">Starts from</label>
            <input
              id="price-from"
              type="date"
              value={form.effective_from}
              onChange={(e) => set('effective_from', e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="price-note">Note (optional)</label>
            <input
              id="price-note"
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
              placeholder="e.g. checked the October invoice"
              maxLength={300}
            />
          </div>
          <div className="field wide">
            <span className="help">
              Bills due on or after this date use the new price until it changes again, including
              unpaid ones already in the payment history. Paid bills keep what was paid.
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="submit" className="btn primary" disabled={busy}>
            Save new price
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

/** Every recorded price, newest first, so "what did this cost last year" has an answer. */
function PriceHistory({ changes, today }: { changes: PriceChange[]; today: string }) {
  const newestFirst = [...changes].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Price history</h2>
        <span className="hint">each bill uses the price in effect on its due date</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">From</th>
              <th className="num" scope="col">Price</th>
              <th className="num" scope="col">Was</th>
              <th scope="col">Changed by</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((change) => (
              <tr key={change.id}>
                <td>
                  {formatDate(change.effective_from)}{' '}
                  {change.effective_from > today ? <Badge tone="info">Upcoming</Badge> : null}
                </td>
                <td className="num">{formatMoney(change.amount, change.currency)}</td>
                <td className="num cell-sub">
                  {change.previous_amount === null
                    ? '—'
                    : formatMoney(change.previous_amount, change.previous_currency ?? change.currency)}
                </td>
                <td className="cell-sub">{change.changed_by ?? '—'}</td>
                <td className="cell-sub">{change.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
