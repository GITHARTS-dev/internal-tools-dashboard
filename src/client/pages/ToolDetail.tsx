import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Banner, EmptyState, Loading, StatusBadge, useToast } from '../components/ui';
import { SeatMeter } from '../components/Charts';
import { annualisedCost, costPerSeat, formatMoney, wastedSeatCost } from '../../shared/money';
import { daysBetween, formatDate, relativeDays } from '../../shared/dates';
import type { Payment } from '../../shared/types';

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

  const { data, error, loading, reload } = useAsync(() => api.tool(id), [id]);
  const today = new Date().toISOString().slice(0, 10);

  if (loading && !data) return <Loading rows={3} />;
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { tool, payments, audit, documents, documents_enabled } = data;
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

  return (
    <>
      <div className="crumb">
        <Link to="/tools">Tools</Link> / {tool.name}
      </div>

      <div className="toolbar">
        <h1 style={{ fontSize: 20 }}>{tool.name}</h1>
        <StatusBadge status={tool.status} />
        <span className="spacer" />
        <Link className="btn" to={`/tools/${tool.id}/edit`}>
          Edit
        </Link>
        <button
          type="button"
          className="btn"
          disabled={busy || !tool.renewal_date}
          title={tool.renewal_date ? 'Create the next payment from this tool\'s cycle' : 'Set a renewal date first'}
          onClick={() => act(() => api.schedulePayment(tool.id), 'Next payment scheduled.')}
        >
          Schedule next payment
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
            className="btn danger"
            disabled={busy}
            onClick={() => act(() => api.archiveTool(tool.id), `${tool.name} marked cancelled.`)}
          >
            Mark cancelled
          </button>
        )}
      </div>

      {tool.status === 'cancelled' ? (
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
            <Detail label="Department">{tool.department ?? '—'}</Detail>
            <Detail label="Vendor">
              {tool.vendor_url ? (
                <a href={tool.vendor_url} target="_blank" rel="noreferrer" style={{ color: 'var(--series-1)' }}>
                  {tool.vendor ?? tool.vendor_url}
                </a>
              ) : (
                tool.vendor ?? '—'
              )}
            </Detail>
            <Detail label="Category">{tool.category}</Detail>
            <Detail label="Cost">
              {tool.cost_amount === null ? '—' : formatMoney(tool.cost_amount, tool.currency)}
              <div className="cell-sub">
                {CYCLE_LABEL[tool.billing_cycle]}
                {annual !== null ? ` · ${formatMoney(annual, tool.currency)}/year` : ''}
              </div>
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
        {payments.length === 0 ? (
          <EmptyState title="No payments recorded">
            Use “Schedule next payment” to create the next one from this tool’s billing cycle.
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
                  <th scope="col">Invoice</th>
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
                    <td className="cell-sub">{payment.invoice_ref ?? '—'}</td>
                    <td className="num">
                      {payment.status === 'due' ? (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={busy}
                          onClick={() => act(() => api.markPaid(payment.id), 'Marked as paid.')}
                        >
                          Mark paid
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
