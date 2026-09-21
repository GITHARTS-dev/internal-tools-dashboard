import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { RenewalTimeline } from '../components/Charts';
import { AlertList, Banner, Loading } from '../components/ui';
import {
  BiggestToolsCard,
  CategoryCard,
  IdleSeatsCard,
  ProductsCard,
  ProvenanceCard,
  SpendLead,
  TrendCard,
} from '../components/spend';
import { formatDate } from '../../shared/dates';

/**
 * One page, two jobs, in the order they should be done.
 *
 * What is due comes before what was spent: the alert list and the renewals sit
 * directly under the opening figure, and the spend analysis follows. The admin
 * who opens this daily lands on what needs doing; the CEO who opens it weekly
 * gets the headline number first and the analysis below it.
 *
 * The two halves load independently. The alerts are the part that must never
 * be unavailable, so a failure fetching the cost figures leaves them in place
 * and says what went wrong, instead of blanking the page.
 */

const ALERTS_SHOWN = 8;

export default function Dashboard() {
  const navigate = useNavigate();
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const { data, error, loading } = useAsync(() => api.dashboard(), []);
  const spend = useAsync(() => api.ceoSummary(), []);

  if (loading && !data) return <Loading rows={4} />;
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { kpis, alerts, category_spend, renewal_timeline, recent_activity } = data;
  const urgent = alerts.filter((a) => a.severity === 'critical');
  const visibleAlerts = showAllAlerts ? alerts : alerts.slice(0, ALERTS_SHOWN);

  const summary = spend.data;

  // Categories with no recorded cost. Left off the chart they would draw a
  // zero-length bar, which reads as "we spend nothing" rather than "we never
  // wrote it down", so the chart names them instead.
  const charted = new Set((summary?.by_category ?? []).map((row) => row.label));
  const uncosted = [
    ...new Set(
      category_spend
        .filter((row) => row.annual === 0 && !charted.has(row.category))
        .map((row) => row.category),
    ),
  ];

  return (
    <>
      {urgent.length > 0 ? (
        <Banner tone="critical">
          <strong>
            {urgent.length === 1
              ? '1 urgent item needs attention today.'
              : `${urgent.length} urgent items need attention today.`}
          </strong>
          <span style={{ marginLeft: 6 }}>
            {alerts.length} things are flagged in total, ordered by what costs the most to ignore.
          </span>
        </Banner>
      ) : (
        <Banner tone="good">Nothing is overdue and no deadline closes in the next few days.</Banner>
      )}

      {summary ? (
        <SpendLead summary={summary} native={kpis.annualised_spend} />
      ) : spend.error ? (
        <Banner tone="warning">
          <span>
            The spend figures could not be loaded: {spend.error}{' '}
            <button type="button" className="btn sm" onClick={spend.reload}>
              Try again
            </button>
          </span>
        </Banner>
      ) : (
        <div className="skeleton" style={{ height: 150 }} aria-label="Loading spend figures" />
      )}

      <section className="card">
        <div className="card-head">
          <h2>Needs attention</h2>
          <span className="hint">
            as of {formatDate(data.today)} · {data.timezone}
          </span>
        </div>
        <AlertList alerts={visibleAlerts} onOpen={(id) => navigate(`/tools/${id}`)} />
        {alerts.length > ALERTS_SHOWN ? (
          <button
            type="button"
            className="btn subtle"
            style={{ marginTop: 10 }}
            onClick={() => setShowAllAlerts((current) => !current)}
          >
            {showAllAlerts
              ? 'Show fewer'
              : `Show all ${alerts.length} — ${alerts.length - ALERTS_SHOWN} more`}
          </button>
        ) : null}
      </section>

      <div className="grid grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Renewals ahead</h2>
            <span className="hint">next 90 days</span>
          </div>
          <RenewalTimeline
            items={renewal_timeline.map((entry) => ({
              id: entry.tool_id,
              name: entry.tool_name,
              date: entry.date,
              daysUntil: entry.days_until,
              amount: entry.amount,
              currency: entry.currency,
            }))}
          />
        </section>

        {summary ? <BiggestToolsCard summary={summary} /> : null}
      </div>

      {summary ? <TrendCard summary={summary} /> : null}

      {summary ? (
        <div className="grid grid-2">
          <CategoryCard summary={summary} uncosted={uncosted} />
          <div className="stack">
            <IdleSeatsCard summary={summary} />
            <ProductsCard summary={summary} />
          </div>
        </div>
      ) : null}

      {recent_activity.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2>Recent changes</h2>
          </div>
          <div>
            {recent_activity.slice(0, 8).map((entry) => (
              <div key={entry.id} className="audit-item">
                <span className="audit-when">{formatDate(entry.created_at.slice(0, 10))}</span>
                <span className="audit-change">
                  {entry.summary ?? entry.action} ·{' '}
                  <span style={{ color: 'var(--text-muted)' }}>{entry.actor}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {summary ? <ProvenanceCard summary={summary} /> : null}
    </>
  );
}
