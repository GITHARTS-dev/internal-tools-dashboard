import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { RenewalTimeline } from '../components/Charts';
import { AlertList, Banner, Loading } from '../components/ui';
import {
  BiggestToolsCard,
  CategoryCard,
  CoverageNotice,
  IdleSeatsCard,
  MethodFooter,
  ProductsCard,
  SpendLead,
  MonthTableCard,
} from '../components/spend';
import { Drilldown, useDrill } from '../components/drilldown';

/**
 * One page, two jobs, in the order they should be done.
 *
 * The headline figure opens the page, then what is due beside what can be
 * reclaimed, then how spend has moved, then where it is concentrated. The admin
 * who opens this daily lands on what needs doing; the CEO who opens it weekly
 * gets the number first and the analysis under it. The change log lives in
 * Settings -- it is an audit trail, not something to read on arrival.
 *
 * Every money figure opens a drill-down (components/drilldown.tsx) into the
 * payments, bills and prices it is made of. Which one is open lives in the URL.
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
  const drill = useDrill();

  if (loading && !data) return <Loading rows={4} />;
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { alerts, category_spend, renewal_timeline } = data;
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
        <>
          <SpendLead summary={summary} onDrill={drill.open} />
          <CoverageNotice summary={summary} />
        </>
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
        <div className="skeleton" style={{ height: 220 }} aria-label="Loading spend figures" />
      )}

      <div className="grid grid-main">
        <section className="card">
          <div className="card-head">
            <h2>Needs attention</h2>
            <span className="hint">{alerts.length === 0 ? 'all clear' : `${alerts.length} flagged`}</span>
          </div>
          <AlertList
            alerts={visibleAlerts}
            // A product alert opens the product, where the cost is entered.
            onOpen={(alert) =>
              navigate(alert.product_id ? `/products/${alert.product_id}` : `/tools/${alert.tool_id}`)
            }
          />
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

        <div className="stack">
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
                noticeDate: entry.notice_date,
                noticeDaysUntil: entry.notice_days_until,
              }))}
            />
          </section>
          {summary ? <IdleSeatsCard summary={summary} /> : null}
        </div>
      </div>

      {/*
        The month-by-month table runs full width: it is the breakdown of the
        headline figure, row by row, and its total row is that figure. Under it,
        the three places the money concentrates, side by side.
      */}
      {summary ? <MonthTableCard summary={summary} onDrill={drill.open} /> : null}

      {summary ? (
        <div className="grid grid-3">
          <BiggestToolsCard summary={summary} onDrill={drill.open} />
          <CategoryCard summary={summary} uncosted={uncosted} />
          <ProductsCard summary={summary} onDrill={drill.open} />
        </div>
      ) : null}

      {summary ? <MethodFooter summary={summary} onDrill={drill.open} /> : null}
      {summary ? <Drilldown summary={summary} /> : null}
    </>
  );
}
