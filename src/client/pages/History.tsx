import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Banner, EmptyState, Loading, StatusBadge } from '../components/ui';
import { formatMoney } from '../../shared/money';
import { formatDate } from '../../shared/dates';

/**
 * Tools we no longer pay for.
 *
 * Nothing is ever deleted, so this is a permanent record of what the company
 * used to spend money on -- including what each one cost in total before it
 * was cancelled.
 */
export default function History() {
  const { data, error, loading } = useAsync(() => api.history(), []);

  if (loading && !data) return <Loading rows={3} />;
  if (error) return <Banner tone="critical">{error}</Banner>;

  const archived = data?.archived ?? [];

  const lifetimeTotals = archived.reduce<Record<string, number>>((acc, entry) => {
    if (!entry.lifetime_paid) return acc;
    acc[entry.lifetime_paid.currency] = (acc[entry.lifetime_paid.currency] ?? 0) + entry.lifetime_paid.amount;
    return acc;
  }, {});

  return (
    <>
      <Banner tone="info">
        Cancelled and expired tools stay here permanently, with their payment history intact. This is
        what makes “what did we spend on X” answerable years later.
      </Banner>

      <section className="card">
        <div className="card-head">
          <h2>
            {archived.length} past tool{archived.length === 1 ? '' : 's'}
          </h2>
          <span className="hint">
            {Object.entries(lifetimeTotals).length > 0
              ? `Lifetime spend ${Object.entries(lifetimeTotals)
                  .map(([currency, amount]) => formatMoney(amount, currency))
                  .join(' + ')}`
              : null}
          </span>
        </div>

        {archived.length === 0 ? (
          <EmptyState title="Nothing archived yet">
            When a tool is cancelled it moves here instead of being deleted.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Category</th>
                  <th scope="col">Used from</th>
                  <th scope="col">Ended</th>
                  <th className="num" scope="col">Total paid</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {archived.map(({ tool, lifetime_paid }) => (
                  <tr key={tool.id}>
                    <td>
                      <Link to={`/tools/${tool.id}`} className="cell-primary">
                        {tool.name}
                      </Link>
                      {tool.notes ? <div className="cell-sub">{tool.notes}</div> : null}
                    </td>
                    <td>{tool.owner_name ?? <span className="cell-sub">—</span>}</td>
                    <td>{tool.category}</td>
                    <td>{tool.started_on ? formatDate(tool.started_on) : '—'}</td>
                    <td>{tool.cancelled_on ? formatDate(tool.cancelled_on) : '—'}</td>
                    <td className="num">
                      {lifetime_paid ? (
                        formatMoney(lifetime_paid.amount, lifetime_paid.currency)
                      ) : (
                        <span className="cell-sub">No payments recorded</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={tool.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
