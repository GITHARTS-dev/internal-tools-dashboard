import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { BarRows, ColumnChart, RenewalTimeline } from '../components/Charts';
import { AlertList, Banner, Loading, StatTile } from '../components/ui';
import { formatDate } from '../../shared/dates';
import { formatMoney } from '../../shared/money';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Headline one currency and mention the rest underneath.
 *
 * Stacking "₹62,807.51 + $45.00" into a stat tile wraps badly and invites the
 * reader to add two different currencies together. No FX rate is applied
 * anywhere in this app, so the tile shows the dominant currency and names the
 * others as a footnote.
 */
function splitTotals(totals: Record<string, number>): { primary: string; secondary: string | null } {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const first = entries[0];
  if (!first) return { primary: '—', secondary: null };

  const rest = entries.slice(1);
  return {
    primary: formatMoney(first[1], first[0], { compact: true }),
    secondary:
      rest.length > 0
        ? `plus ${rest.map(([currency, amount]) => formatMoney(amount, currency, { compact: true })).join(', ')}`
        : null,
  };
}

function monthLabel(month: string): { short: string; full: string } {
  const [year = '', m = ''] = month.split('-');
  const name = MONTH_LABELS[Number(m) - 1] ?? m;
  return { short: name, full: `${name} ${year}` };
}

const ALERTS_SHOWN = 8;

export default function Dashboard() {
  const navigate = useNavigate();
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const { data, error, loading } = useAsync(() => api.dashboard(), []);

  if (loading && !data) return <Loading rows={4} />;
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { kpis, alerts, category_spend, renewal_timeline, paid_by_month, recent_activity } = data;
  const currency = kpis.dominant_currency ?? 'INR';
  const urgent = alerts.filter((a) => a.severity === 'critical');

  // Charts show one currency at a time; mixing two into one bar would be a lie.
  const categoryRows = category_spend
    // A category whose tools have no recorded cost draws a zero-length bar,
    // which reads as "we spend nothing" rather than "we never wrote it down".
    .filter((row) => row.currency === currency && row.annual > 0)
    .slice(0, 8)
    .map((row) => ({
      label: row.category,
      value: row.annual,
      sublabel: `${row.tool_count} tool${row.tool_count === 1 ? '' : 's'}`,
    }));

  const monthPoints = paid_by_month
    .filter((row) => row.currency === currency)
    .map((row) => ({ label: monthLabel(row.month).short, fullLabel: monthLabel(row.month).full, value: row.amount }));

  const otherCurrencies = Object.keys(kpis.annualised_spend).filter((c) => c !== currency);
  const uncosted = category_spend.filter((row) => row.currency === currency && row.annual === 0);
  const visibleAlerts = showAllAlerts ? alerts : alerts.slice(0, ALERTS_SHOWN);

  const monthly = splitTotals(kpis.monthly_run_rate);
  const annual = splitTotals(kpis.annualised_spend);
  const idle = splitTotals(kpis.wasted_seat_cost);

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

      <div className="grid grid-kpi">
        <StatTile
          label="Needs attention"
          value={alerts.length}
          critical={urgent.length > 0}
          note={urgent.length > 0 ? `${urgent.length} urgent` : 'nothing urgent'}
        />
        <StatTile
          label="Monthly run-rate"
          value={monthly.primary}
          note="recurring subscriptions only"
          extra={monthly.secondary}
        />
        <StatTile
          label="Annualised spend"
          value={annual.primary}
          note={`${kpis.active_tools} active · ${kpis.trial_tools} trial`}
          extra={annual.secondary}
        />
        <StatTile
          label="Idle seat cost"
          value={idle.primary}
          note={`per year · ${kpis.seats_purchased - kpis.seats_used} of ${kpis.seats_purchased} seats unused`}
          extra={idle.secondary}
        />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Needs attention</h2>
          <span className="hint">as of {formatDate(data.today)} · {data.timezone}</span>
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

        <section className="card">
          <div className="card-head">
            <h2>Spend by category</h2>
            <span className="hint">annualised, {currency}</span>
          </div>
          <BarRows rows={categoryRows} currency={currency} />
          {otherCurrencies.length > 0 ? (
            <p className="card-sub" style={{ marginTop: 12, marginBottom: 0 }}>
              Plus{' '}
              {otherCurrencies
                .map((c) => formatMoney(kpis.annualised_spend[c] ?? 0, c))
                .join(', ')}{' '}
              a year billed in {otherCurrencies.join(' and ')}, shown separately because no exchange
              rate is applied.
            </p>
          ) : null}
          {uncosted.length > 0 ? (
            <p className="card-sub" style={{ marginTop: 8, marginBottom: 0 }}>
              {uncosted.map((row) => row.category).join(', ')} not shown — no cost recorded for
              those tools yet.
            </p>
          ) : null}
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>What we actually paid</h2>
          <span className="hint">by month, from the payment ledger</span>
        </div>
        <ColumnChart points={monthPoints} currency={currency} />
      </section>

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
                  {entry.summary ?? entry.action} · <span style={{ color: 'var(--text-muted)' }}>{entry.actor}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
