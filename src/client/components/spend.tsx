import { Link } from 'react-router-dom';
import { AreaTrend, BarRows } from './Charts';
import { Badge, Banner, EmptyState, MoneyTotals } from './ui';
import { IconExchange } from './icons';
import { formatDate } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import type { CeoSummary } from '../../shared/types';

/**
 * The money half of the dashboard.
 *
 * These were a separate "cost summary" page until it turned out that half of
 * what that page showed the dashboard already showed too. They are components
 * rather than one block so the dashboard can place each beside the question it
 * answers -- alerts first, because acting on what is due comes before analysing
 * what was spent -- instead of stacking two pages end to end.
 *
 * Every figure here has been through an exchange rate, so the real job of this
 * file is making the basis of those figures impossible to miss: what was
 * converted, at which month's rate, and what could not be converted at all.
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(month: string, withYear = false): string {
  const name = MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${name} ${month.slice(0, 4)}` : name;
}

export function Money({ amount, currency }: { amount: number | null; currency: string }) {
  if (amount === null) return <span title="No exchange rate covered these amounts">Unavailable</span>;
  return <span>{formatMoney(amount, currency)}</span>;
}

/**
 * Direction of travel.
 *
 * Spending more is not automatically bad, so this deliberately does not use the
 * good/critical status colours -- it states the direction and the size and lets
 * the reader judge. The arrow is drawn, not a glyph, and the words "up on" /
 * "down on" are always present, so the meaning survives greyscale.
 */
export function Delta({ pct }: { pct: number | null }) {
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

// -------------------------------------------------------------------- lead

/**
 * The one number the spend half exists to deliver.
 *
 * Not a card: it sits directly on the page ground, which is what makes it read
 * as the page's opening statement rather than the first of several equal tiles.
 * Two columns on a wide screen so it costs about 150px of height rather than
 * 300 -- it shares the top of the page with the alerts, and must not push them
 * below the fold.
 *
 * `native` is the per-currency breakdown from before conversion. It is shown
 * only when there is more than one currency, since a lone one would just repeat
 * the headline.
 */
export function SpendLead({
  summary,
  native,
}: {
  summary: CeoSummary;
  native?: Record<string, number>;
}) {
  const currency = summary.reporting_currency;
  const bought = summary.subscriptions.annual_reported ?? 0;
  const internal = summary.internal.annual_reported ?? 0;
  const combined = bought + internal;
  const boughtPct = combined > 0 ? (bought / combined) * 100 : 0;
  const hasNative = native !== undefined && Object.keys(native).length > 1;
  // Once cloud usage is in the figure it is no longer purely a commitment, and
  // calling it one would overstate how fixed it is.
  const hasUsage = summary.internal.usage_annual_reported !== null;

  return (
    <section className="lead" aria-labelledby="lead-heading">
      <div className="lead-main">
        <h2 id="lead-heading" className="lead-label">
          {hasUsage ? 'Annual spend' : 'Committed spend'}
        </h2>

        <div className="lead-figure">
          <span className="lead-value">
            <Money amount={summary.total_annual_reported} currency={currency} />
          </span>
          <span className="lead-unit">a year</span>
        </div>

        {/*
          The run rate and the payment trend are different measures, so they get
          different lines. Putting the delta beside the headline would say the
          headline itself moved, which is not what was measured.
        */}
        <div className="lead-meta">
          <span className="lead-rate">
            {hasUsage
              ? 'Subscriptions at today\u2019s prices, plus cloud usage at its recent average'
              : 'What we are committed to at today\u2019s prices'}{' '}
            · <Money amount={summary.total_monthly_reported} currency={currency} /> a month
          </span>
        </div>

        {summary.comparison.trailing_12 !== null ? (
          <p className="lead-actual">
            We actually paid{' '}
            <strong>
              <Money amount={summary.comparison.trailing_12} currency={currency} />
            </strong>{' '}
            over the last 12 complete months — <Delta pct={summary.comparison.change_pct} />.
          </p>
        ) : null}

        {hasNative ? (
          <p className="lead-native">
            Before conversion: <MoneyTotals totals={native} />
          </p>
        ) : null}
      </div>

      <div className="lead-side">
        {/*
          A part-to-whole bar needs two parts. With nothing attributed to an
          internal product it would render as a full-width block, which reads as
          a progress bar at 100% rather than as a split.
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
              <Money amount={summary.subscriptions.annual_reported} currency={currency} />
              <span className="split-key-sub">
                {summary.subscriptions.tool_count}{' '}
                {summary.subscriptions.tool_count === 1 ? 'tool' : 'tools'}
              </span>
            </dd>
          </div>
          <div className="split-key-item">
            <dt>
              <span className="key-swatch" style={{ background: 'var(--series-2)' }} />
              Running our own products
            </dt>
            <dd>
              <Money amount={summary.internal.annual_reported} currency={currency} />
              <span className="split-key-sub">
                {summary.internal.product_count}{' '}
                {summary.internal.product_count === 1 ? 'product' : 'products'} ·{' '}
                {hasUsage ? 'subscriptions and usage' : 'licences only'}
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- trend

export function TrendCard({ summary }: { summary: CeoSummary }) {
  const currency = summary.reporting_currency;
  const { comparison } = summary;

  const trend = summary.paid_by_month.map((row) => ({
    label: monthLabel(row.month),
    fullLabel: monthLabel(row.month, true),
    value: row.amount,
  }));

  return (
    <section className="card">
      <div className="card-head">
        <h2>What we actually paid</h2>
        <span className="hint">two years, from the ledger</span>
      </div>
      <div className="card-sub">
        Complete months only — the current month is still being paid, and plotting a part-month
        beside full ones would read as a drop that has not happened.
      </div>

      <AreaTrend points={trend} currency={currency} splitAt={12} />

      {comparison.trailing_12 !== null ? (
        <div className="compare">
          <div className="compare-item">
            <span className="compare-label">
              {comparison.from ? monthLabel(comparison.from, true) : ''} –{' '}
              {comparison.to ? monthLabel(comparison.to, true) : ''}
            </span>
            <span className="compare-value">
              <Money amount={comparison.trailing_12} currency={currency} />
            </span>
          </div>
          <div className="compare-item is-muted">
            <span className="compare-label">The 12 months before</span>
            <span className="compare-value">
              <Money amount={comparison.previous_12} currency={currency} />
            </span>
          </div>
          <div className="compare-item">
            <span className="compare-label">Change</span>
            <span className="compare-value">
              <Delta pct={comparison.change_pct} />
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------ concentration

export function BiggestToolsCard({ summary }: { summary: CeoSummary }) {
  const currency = summary.reporting_currency;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Our biggest subscriptions</h2>
        <span className="hint">a year each</span>
      </div>
      {summary.top_tools.length === 0 ? (
        <EmptyState title="No costed tools yet" compact />
      ) : (
        <BarRows
          rows={summary.top_tools.map((row) => ({
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
    </section>
  );
}

/**
 * `uncosted` are categories whose tools have no recorded cost. Left off the
 * chart they would draw a zero-length bar, which reads as "we spend nothing"
 * rather than "we never wrote it down" -- so they are named underneath instead.
 */
export function CategoryCard({
  summary,
  uncosted,
}: {
  summary: CeoSummary;
  uncosted: string[];
}) {
  const currency = summary.reporting_currency;

  return (
    <section className="card">
      <div className="card-head">
        <h2>By category</h2>
        <span className="hint">a year each</span>
      </div>
      {summary.by_category.length === 0 ? (
        <EmptyState title="No costed tools yet" compact />
      ) : (
        <BarRows
          rows={summary.by_category.map((row) => ({ label: row.label, value: row.annual_reported }))}
          currency={currency}
        />
      )}
      {uncosted.length > 0 ? (
        <p className="card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
          {uncosted.join(', ')} not shown — no cost recorded for those tools yet.
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- products

export function ProductsCard({ summary }: { summary: CeoSummary }) {
  const currency = summary.reporting_currency;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Our products</h2>
        <span className="hint">
          <Link to="/products">Manage products</Link>
        </span>
      </div>

      {summary.products.length === 0 ? (
        <EmptyState title="No internal products yet" compact>
          Add one on the <Link to="/products">Our products</Link> screen, then attribute its
          subscriptions to it and record what it costs each month.
        </EmptyState>
      ) : (
        <div>
          {summary.products.map((entry) => {
            const hasUsage = entry.usage_monthly_reported !== null;
            const fixedKnown = (entry.fixed_annual_reported ?? 0) > 0;
            // Nothing recorded on either side. Showing 0.00 here would say the
            // product is free, when the truth is that nobody has entered its cost.
            const unknown = !hasUsage && !fixedKnown;
            return (
              <div className="product-row" key={entry.product.id}>
                <div style={{ minWidth: 0 }}>
                  <div className="product-name">
                    <Link to={`/products/${entry.product.id}`}>{entry.product.name}</Link>
                  </div>
                  <div className="product-meta">
                    {hasUsage ? (
                      <>
                        {/* A zero subscription part is noise, not information. */}
                        {fixedKnown ? (
                          <>
                            <Money amount={entry.fixed_annual_reported} currency={currency} />{' '}
                            subscriptions{' + '}
                          </>
                        ) : null}
                        <Money amount={entry.usage_annual_reported} currency={currency} /> usage
                        {entry.usage_months_counted > 0
                          ? ` (${entry.usage_months_counted}-month average)`
                          : ''}
                      </>
                    ) : (
                      <>
                        {entry.tool_count} {entry.tool_count === 1 ? 'subscription' : 'subscriptions'}
                        {' · '}no usage costs entered
                      </>
                    )}
                    {entry.product.owner_name ? ` · ${entry.product.owner_name}` : ''}
                    {entry.product.status !== 'live' ? ` · ${entry.product.status}` : ''}
                  </div>
                  {entry.latest_month_missing ? (
                    <div style={{ marginTop: 6 }}>
                      <Link to={`/products/${entry.product.id}`}>
                        <Badge tone="warning">
                          {monthLabel(summary.latest_complete_month, true)} costs not entered
                        </Badge>
                      </Link>
                    </div>
                  ) : null}
                </div>
                <div className="product-cost">
                  {unknown ? (
                    <>
                      <div className="primary" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                        Not known yet
                      </div>
                      <div className="secondary">no cost recorded</div>
                    </>
                  ) : (
                    <>
                      <div className="primary">
                        <Money amount={entry.annual_reported} currency={currency} />
                      </div>
                      <div className="secondary">a year</div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------- idle seats

export function IdleSeatsCard({ summary }: { summary: CeoSummary }) {
  if (summary.idle_seat_cost === null || summary.idle_seat_cost <= 0) return null;
  const currency = summary.reporting_currency;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Seats nobody is using</h2>
      </div>
      <div className="reclaim">
        <span className="reclaim-value">{formatMoney(summary.idle_seat_cost, currency)}</span>
        <span className="reclaim-note">
          a year across {summary.idle_seat_count} paid{' '}
          {summary.idle_seat_count === 1 ? 'seat' : 'seats'} with nobody on them. The one figure
          here that is already recoverable — <Link to="/tools">right-size them</Link> at the next
          renewal.
        </span>
      </div>
    </section>
  );
}

// -------------------------------------------------------------- provenance

export function ProvenanceCard({ summary }: { summary: CeoSummary }) {
  const currency = summary.reporting_currency;

  return (
    <section className="card is-quiet">
      <div className="card-head">
        <h2>How the spend figures were made</h2>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="rate-note">
          <IconExchange size={14} />
          <span>
            Amounts not already in {currency} are converted at European Central Bank reference
            rates. Run-rate figures use the latest month available; historical payments use the
            month they were paid in, so a past year&rsquo;s total never changes.
          </span>
        </div>

        {summary.rate_months.length > 0 ? (
          <div className="rate-note">
            <span>
              Rates used span {summary.rate_months[0]} to{' '}
              {summary.rate_months[summary.rate_months.length - 1]}.
            </span>
          </div>
        ) : null}

        {!summary.fx_available ? (
          <Banner tone="warning">
            <span>
              No exchange rates are stored yet, so anything not already in {currency} is missing
              from these figures. <Link to="/settings">Fetch rates in Settings</Link> to complete
              them.
            </span>
          </Banner>
        ) : summary.gaps.length > 0 ? (
          <Banner tone="warning">
            <div>
              <strong>Some amounts are missing from these figures.</strong>
              <div style={{ marginTop: 4 }}>
                No exchange rate covered them, so they were left out rather than guessed at.
              </div>
              <div className="gap-list">
                {summary.gaps.map((gap) => (
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
            <span>Every amount was converted; nothing is missing from these figures.</span>
          </div>
        )}

        <div className="rate-note">
          <span>
            Running cost covers subscription, licence and cloud cash only. Staff time is not
            included. Cloud usage is entered by hand each month and averaged over the last three
            complete months, so it is an estimate rather than a commitment.
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
                {summary.paid_by_year.map((row) => (
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
          <span>As at {formatDate(summary.today)}.</span>
        </div>
      </div>
    </section>
  );
}
