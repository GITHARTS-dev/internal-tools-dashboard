import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, Banner, EmptyState, Loading } from '../components/ui';
import { AreaTrend, BarRows } from '../components/Charts';
import { IconExchange } from '../components/icons';
import { formatMoney } from '../../shared/money';
import { formatDate } from '../../shared/dates';
import type { CeoSummary } from '../../shared/types';

/**
 * The CEO view.
 *
 * Ordered by the questions actually asked, not by what is easy to compute:
 *
 *   1. What do we spend, and is it going up?   -> the opening figure and delta
 *   2. What does the trend look like?          -> two years of paid months
 *   3. Where is it concentrated?               -> ranked tools and categories
 *   4. What could we stop paying for?          -> idle seats
 *   5. Can I trust these numbers?              -> the provenance note, last
 *
 * Every figure here has been through an exchange rate, so the page's real job
 * is not the totals -- it is making their basis impossible to miss. What was
 * converted, at which month's rate, and what could not be converted at all are
 * on the page rather than in a tooltip.
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(month: string, withYear = false): string {
  const name = MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${name} ${month.slice(0, 4)}` : name;
}

function Money({ amount, currency }: { amount: number | null; currency: string }) {
  if (amount === null) return <span title="No exchange rate covered these amounts">Unavailable</span>;
  return <span>{formatMoney(amount, currency)}</span>;
}

/**
 * Direction of travel.
 *
 * Spending more is not automatically bad, so this deliberately does not use the
 * good/critical status colours -- it states the direction and the size and lets
 * the reader judge. The arrow is drawn, not a glyph, and the word "up"/"down"
 * is always present, so the meaning survives greyscale.
 */
function Delta({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const rounded = Math.round(Math.abs(pct));
  // Lowercase: this reads inline mid-sentence more often than it stands alone.
  if (rounded === 0) return <span className="delta is-flat">level with the year before</span>;

  const up = pct > 0;
  return (
    <span className={`delta ${up ? 'is-up' : 'is-down'}`}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d={up ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6'}
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {rounded}% {up ? 'up on' : 'down on'} the year before
    </span>
  );
}

export default function CostSummary() {
  const [data, setData] = useState<CeoSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .ceoSummary()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the summary.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="card">
        <EmptyState title="Could not load the summary">{error}</EmptyState>
      </div>
    );
  }
  if (!data) return <Loading rows={4} />;

  const currency = data.reporting_currency;
  const bought = data.subscriptions.annual_reported ?? 0;
  const internal = data.internal.annual_reported ?? 0;
  const combined = bought + internal;
  const boughtPct = combined > 0 ? (bought / combined) * 100 : 0;

  const trend = data.paid_by_month.map((row) => ({
    label: monthLabel(row.month),
    fullLabel: monthLabel(row.month, true),
    value: row.amount,
  }));

  return (
    <>
      {!data.fx_available ? (
        <Banner tone="warning">
          <span>
            No exchange rates are stored yet, so anything not already in {currency} is missing from
            these totals. <Link to="/settings">Fetch rates in Settings</Link> to complete them.
          </span>
        </Banner>
      ) : null}

      {/* ---------------------------------------------------------- the lead */}
      <section className="lead" aria-labelledby="lead-heading">
        <h2 id="lead-heading" className="lead-label">
          Committed spend
        </h2>

        <div className="lead-figure">
          <span className="lead-value">
            <Money amount={data.total_annual_reported} currency={currency} />
          </span>
          <span className="lead-unit">a year</span>
        </div>

        {/*
          The run rate and the payment trend are different measures, so they get
          different lines. Putting the delta beside the headline would say the
          headline itself moved 31%, which is not what was measured.
        */}
        <div className="lead-meta">
          <span className="lead-rate">
            What we are committed to at today&rsquo;s prices ·{' '}
            <Money amount={data.total_monthly_reported} currency={currency} /> a month
          </span>
        </div>

        {data.comparison.trailing_12 !== null ? (
          <p className="lead-actual">
            We actually paid{' '}
            <strong>
              <Money amount={data.comparison.trailing_12} currency={currency} />
            </strong>{' '}
            over the last 12 complete months — <Delta pct={data.comparison.change_pct} />.
          </p>
        ) : null}

        <div className="lead-split">
          {/*
            A part-to-whole bar needs two parts. With nothing attributed to an
            internal product it would render as a full-width block, which reads
            as a progress bar at 100% rather than as a split.
          */}
          {bought > 0 && internal > 0 ? (
            <div
              className="proportion"
              role="img"
              aria-label={`Bought subscriptions ${Math.round(boughtPct)} percent of annual spend, our own products ${Math.round(100 - boughtPct)} percent`}
            >
              <span className="bought" style={{ width: `${boughtPct}%` }} />
              <span className="internal" style={{ width: `${100 - boughtPct}%` }} />
            </div>
          ) : null}

          <dl className="split-key">
            <div className="split-key-item">
              <dt>
                <span className="key-swatch" style={{ background: 'var(--series-1)' }} />
                Subscriptions we buy
              </dt>
              <dd>
                <Money amount={data.subscriptions.annual_reported} currency={currency} />
                <span className="split-key-sub">
                  {data.subscriptions.tool_count}{' '}
                  {data.subscriptions.tool_count === 1 ? 'tool' : 'tools'}
                </span>
              </dd>
            </div>
            <div className="split-key-item">
              <dt>
                <span className="key-swatch" style={{ background: 'var(--series-2)' }} />
                Running our own products
              </dt>
              <dd>
                <Money amount={data.internal.annual_reported} currency={currency} />
                <span className="split-key-sub">
                  {data.internal.product_count}{' '}
                  {data.internal.product_count === 1 ? 'product' : 'products'} · licences only
                </span>
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ------------------------------------------------------------- trend */}
      <div className="card">
        <div className="card-head">
          <h2>What we actually paid</h2>
          <span className="hint">two years, from the ledger</span>
        </div>
        <div className="card-sub">
          Complete months only — the current month is still being paid, and plotting a part-month
          beside full ones would read as a drop that has not happened.
        </div>

        <AreaTrend points={trend} currency={currency} splitAt={12} />

        {data.comparison.trailing_12 !== null ? (
          <div className="compare">
            <div className="compare-item">
              <span className="compare-label">
                {data.comparison.from ? monthLabel(data.comparison.from, true) : ''} –{' '}
                {data.comparison.to ? monthLabel(data.comparison.to, true) : ''}
              </span>
              <span className="compare-value">
                <Money amount={data.comparison.trailing_12} currency={currency} />
              </span>
            </div>
            <div className="compare-item is-muted">
              <span className="compare-label">The 12 months before</span>
              <span className="compare-value">
                <Money amount={data.comparison.previous_12} currency={currency} />
              </span>
            </div>
            <div className="compare-item">
              <span className="compare-label">Change</span>
              <span className="compare-value">
                <Delta pct={data.comparison.change_pct} />
              </span>
            </div>
          </div>
        ) : null}
      </div>

      {/* --------------------------------------------------- concentration */}
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Our biggest subscriptions</h2>
            <span className="hint">a year each</span>
          </div>
          {data.top_tools.length === 0 ? (
            <EmptyState title="No costed tools yet" />
          ) : (
            <BarRows
              rows={data.top_tools.map((row) => ({
                label: row.label,
                value: row.annual_reported,
                sublabel:
                  row.currency !== currency && row.amount !== null
                    ? `${formatMoney(row.amount, row.currency)} before conversion`
                    : (row.sublabel ?? undefined),
              }))}
              currency={currency}
            />
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>By category</h2>
            <span className="hint">a year each</span>
          </div>
          {data.by_category.length === 0 ? (
            <EmptyState title="No costed tools yet" />
          ) : (
            <BarRows
              rows={data.by_category.map((row) => ({ label: row.label, value: row.annual_reported }))}
              currency={currency}
            />
          )}
        </div>
      </div>

      {/* ------------------------------------------------------- our products */}
      <div className="card">
        <div className="card-head">
          <h2>Our products</h2>
          <span className="hint">
            <Link to="/products">Manage products</Link>
          </span>
        </div>

        {data.products.length === 0 ? (
          <EmptyState title="No internal products yet" compact>
            Add one on the <Link to="/products">Our products</Link> screen, then attribute its
            hosting, domain and API subscriptions to it. Its running cost is the roll-up of those.
          </EmptyState>
        ) : (
          <div>
            {data.products.map((entry) => (
              <div className="product-row" key={entry.product.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="product-name">
                    <Link to={`/products/${entry.product.id}`}>{entry.product.name}</Link>
                  </div>
                  <div className="product-meta">
                    {entry.tool_count} {entry.tool_count === 1 ? 'subscription' : 'subscriptions'}
                    {entry.product.owner_name ? ` · ${entry.product.owner_name}` : ''}
                    {entry.product.status !== 'live' ? ` · ${entry.product.status}` : ''}
                  </div>
                </div>
                <div className="product-cost">
                  <div className="primary">
                    <Money amount={entry.annual_reported} currency={currency} />
                  </div>
                  <div className="secondary">a year</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------- waste */}
      {data.idle_seat_cost !== null && data.idle_seat_cost > 0 ? (
        <div className="card">
          <div className="card-head">
            <h2>Seats nobody is using</h2>
          </div>
          <div className="reclaim">
            <span className="reclaim-value">{formatMoney(data.idle_seat_cost, currency)}</span>
            <span className="reclaim-note">
              a year across {data.idle_seat_count} paid{' '}
              {data.idle_seat_count === 1 ? 'seat' : 'seats'} with nobody on them. This is the one
              number here that is already recoverable — <Link to="/tools">right-size them</Link> at
              the next renewal.
            </span>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------------- provenance */}
      <div className="card is-quiet">
        <div className="card-head">
          <h2>How these numbers were made</h2>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="rate-note">
            <IconExchange size={14} />
            <span>
              Amounts not already in {currency} are converted at European Central Bank reference
              rates. Run-rate figures use the latest month available; historical payments use the
              month they were paid in, so a past year's total never changes.
            </span>
          </div>

          {data.rate_months.length > 0 ? (
            <div className="rate-note">
              <span>
                Rates used span {data.rate_months[0]} to {data.rate_months[data.rate_months.length - 1]}.
              </span>
            </div>
          ) : null}

          {data.gaps.length > 0 ? (
            <Banner tone="warning">
              <div>
                <strong>Some amounts are missing from these totals.</strong>
                <div style={{ marginTop: 4 }}>
                  No exchange rate covered them, so they were left out rather than guessed at.
                </div>
                <div className="gap-list">
                  {data.gaps.map((gap) => (
                    <Badge tone="warning" key={`${gap.currency}-${gap.month}`}>
                      {gap.currency}
                      {gap.month ? ` · ${gap.month}` : ''} · {gap.count}{' '}
                      {gap.count === 1 ? 'amount' : 'amounts'}
                    </Badge>
                  ))}
                </div>
                <div style={{ marginTop: 8 }}>
                  <Link to="/settings">Fetch a wider range of rates</Link> to close the gap.
                </div>
              </div>
            </Banner>
          ) : (
            <div className="rate-note">
              <span>Every amount was converted; nothing is missing from these totals.</span>
            </div>
          )}

          <div className="rate-note">
            <span>
              Running cost covers subscription and licence cash only. Staff time is not included.
            </span>
          </div>

          <details className="figures">
            <summary>Paid by year, as figures</summary>
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Year</th>
                    <th className="num">Paid ({currency})</th>
                  </tr>
                </thead>
                <tbody>
                  {data.paid_by_year.map((row) => (
                    <tr key={row.year}>
                      <td className="cell-primary">{row.year}</td>
                      <td className="num">{formatMoney(row.amount, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          <div className="rate-note">
            <span>As at {formatDate(data.today)}.</span>
          </div>
        </div>
      </div>
    </>
  );
}
