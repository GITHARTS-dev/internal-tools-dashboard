import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Banner, EmptyState, Loading, MoneyTotals, useToast } from '../components/ui';
import { formatMoney } from '../../shared/money';
import { daysBetween, formatDate, relativeDays } from '../../shared/dates';
import type { Payment } from '../../shared/types';

type View = 'outstanding' | 'paid' | 'all';

/**
 * The ledger.
 *
 * "Overdue" is derived from the due date rather than stored, exactly as the
 * alert engine derives it -- so this table and the dashboard queue can never
 * disagree about which bills are late.
 */
export default function Payments() {
  const toast = useToast();

  async function exportCsv() {
    try {
      await api.downloadCsv('payments');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not build that file.', 'error');
    }
  }
  const [view, setView] = useState<View>('outstanding');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const statusParam = view === 'paid' ? ['paid'] : view === 'outstanding' ? ['due'] : [];
  const { data, error, loading, reload } = useAsync(
    () => api.payments(statusParam.length > 0 ? { status: statusParam } : {}),
    [view],
  );

  const today = new Date().toISOString().slice(0, 10);
  const payments = data?.payments ?? [];
  const names = data?.tool_names ?? {};

  const totals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const payment of payments) {
      if (payment.status === 'waived') continue;
      out[payment.currency] = (out[payment.currency] ?? 0) + payment.amount;
    }
    return out;
  }, [payments]);

  const overdue = payments.filter((p) => p.status === 'due' && daysBetween(today, p.due_date) < 0);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const due = payments.filter((p) => p.status === 'due').map((p) => p.id);
    setSelected((current) => (current.size === due.length ? new Set() : new Set(due)));
  }

  async function markSelectedPaid() {
    setBusy(true);
    try {
      const { count } = await api.bulkMarkPaid([...selected]);
      toast(`${count} payment${count === 1 ? '' : 's'} marked paid.`);
      setSelected(new Set());
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function markOne(id: string) {
    setBusy(true);
    try {
      await api.markPaid(id);
      toast('Marked as paid.');
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  }

  const dueCount = payments.filter((p) => p.status === 'due').length;

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Which payments to show">
          {(
            [
              ['outstanding', 'Outstanding'],
              ['paid', 'Paid'],
              ['all', 'All'],
            ] as Array<[View, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={view === key ? 'active' : ''}
              onClick={() => {
                setView(key);
                setSelected(new Set());
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="spacer" />
        {selected.size > 0 ? (
          <button type="button" className="btn primary" disabled={busy} onClick={markSelectedPaid}>
            Mark {selected.size} paid
          </button>
        ) : null}
        <button type="button" className="btn" onClick={() => exportCsv()}>
          Export CSV
        </button>
      </div>

      {error ? <Banner tone="critical">{error}</Banner> : null}

      {overdue.length > 0 && view !== 'paid' ? (
        <Banner tone="critical">
          <strong>
            {overdue.length} payment{overdue.length === 1 ? ' is' : 's are'} overdue
          </strong>
          <span style={{ marginLeft: 6 }}>
            totalling <MoneyTotals totals={overdue.reduce<Record<string, number>>((acc, p) => {
              acc[p.currency] = (acc[p.currency] ?? 0) + p.amount;
              return acc;
            }, {})} />
            .
          </span>
        </Banner>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>
            {payments.length} payment{payments.length === 1 ? '' : 's'}
          </h2>
          <span className="hint">
            Total <MoneyTotals totals={totals} />
          </span>
        </div>

        {loading && !data ? (
          <Loading />
        ) : payments.length === 0 ? (
          <EmptyState title="Nothing here">
            {view === 'outstanding'
              ? 'No payments are currently outstanding.'
              : 'No payments recorded for this filter.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 34 }}>
                    {dueCount > 0 ? (
                      <input
                        type="checkbox"
                        checked={selected.size > 0 && selected.size === dueCount}
                        onChange={toggleAll}
                        aria-label="Select all outstanding payments"
                      />
                    ) : null}
                  </th>
                  <th scope="col">Tool</th>
                  <th scope="col">Due</th>
                  <th className="num" scope="col">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col">Paid on</th>
                  <th scope="col">Invoice</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {payments.map((payment: Payment) => {
                  const days = daysBetween(today, payment.due_date);
                  const isOverdue = payment.status === 'due' && days < 0;
                  return (
                    <tr key={payment.id}>
                      <td>
                        {payment.status === 'due' ? (
                          <input
                            type="checkbox"
                            checked={selected.has(payment.id)}
                            onChange={() => toggle(payment.id)}
                            aria-label={`Select payment for ${names[payment.tool_id] ?? 'tool'}`}
                          />
                        ) : null}
                      </td>
                      <td>
                        <Link to={`/tools/${payment.tool_id}`} className="cell-primary">
                          {names[payment.tool_id] ?? 'Unknown tool'}
                        </Link>
                      </td>
                      <td>
                        {formatDate(payment.due_date)}
                        {payment.status === 'due' ? (
                          <div className="cell-sub">{relativeDays(days)}</div>
                        ) : null}
                      </td>
                      <td className="num">{formatMoney(payment.amount, payment.currency)}</td>
                      <td>
                        {payment.status === 'paid' ? (
                          <Badge tone="good" dot>Paid</Badge>
                        ) : payment.status === 'waived' ? (
                          <Badge tone="info" dot>Waived</Badge>
                        ) : isOverdue ? (
                          <Badge tone="critical" dot>Overdue</Badge>
                        ) : (
                          <Badge tone={days <= 7 ? 'warning' : 'info'} dot>Due</Badge>
                        )}
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
                            onClick={() => markOne(payment.id)}
                          >
                            Mark paid
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
