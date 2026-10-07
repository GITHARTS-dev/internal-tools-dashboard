import { Link } from 'react-router-dom';
import {
  BarRows,
  CumulativeCompare,
  SeatMeter,
  Sparkline,
  StackedColumns,
  type CumulativeInput,
} from './Charts';
import { Badge, Banner, EmptyState } from './ui';
import { IconChevronRight } from './icons';
import type { DrillView } from './drilldown';
import { formatDate } from '../../shared/dates';
import { breakdown, itemsBetween, splitYear } from '../../shared/drilldown';
import { monthOf } from '../../shared/fx';
import { formatMoney, formatShort } from '../../shared/money';
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
 * The headline: what has actually been spent this year, beside what the year
 * is committed to by 31 December.
 *
 * Money already paid leads, because it is a fact; the committed total sits
 * beside it -- paid, plus the subscription bills still to come on their real
 * dates -- split so it never reads as spent. Cloud usage still to be billed is
 * not guessed at: it joins the total as each month's bill is entered.
 * (A twelve-month run rate used to stand here, and read as money already gone;
 * it is now one click into the forecast, for comparing tools.) Every figure
 * opens a drill-down into the payments, bills and prices it is made of.
 *
 * Two columns on a wide screen so it costs about 150px of height rather than
 * 300 -- it shares the top of the page with the alerts, and must not push them
 * below the fold.
 */
export function SpendLead({
  summary,
  onDrill,
}: {
  summary: CeoSummary;
  onDrill: (view: DrillView) => void;
}) {
  const currency = summary.reporting_currency;
  const year = summary.today.slice(0, 4);
  const thisYear = breakdown(itemsBetween(summary.paid_items, `${year}-01`, monthOf(summary.today)), currency);
  const currencies = thisYear.by_currency.map((line) => line.currency);

  const forecast = summary.year_forecast;
  const toCome = forecast.total - forecast.paid;
  const split = splitYear(summary.paid_items, forecast);
  const last12 = summary.paid_by_month.slice(-12);

  return (
    <section className="lead" aria-labelledby="lead-heading">
      <div className="lead-main">
        <h2 id="lead-heading" className="lead-label">
          Spent in {year} so far
        </h2>

        <button
          type="button"
          className="lead-figure lead-button"
          onClick={() => onDrill({ kind: 'year', year })}
          aria-label={`Spent in ${year} so far: ${formatMoney(thisYear.total, currency)}. Open every payment and bill.`}
        >
          <span className="lead-value">{formatMoney(thisYear.total, currency)}</span>
          <span className="lead-unit">
            since 1 Jan <IconChevronRight size={13} />
          </span>
        </button>

        <div className="lead-meta">
          <span className="lead-rate">
            {formatMoney(thisYear.subscriptions, currency)} on subscriptions
            {thisYear.usage > 0 ? ` + ${formatMoney(thisYear.usage, currency)} on our products' cloud usage` : ''}
            {currencies.length > 1 ? `, paid in ${joinWords(currencies)} and shown in ${currency}` : ''}.{' '}
            <button type="button" className="link-button" onClick={() => onDrill({ kind: 'year', year })}>
              See every payment
            </button>
          </span>
        </div>

        {summary.comparison.trailing_12 !== null ? (
          <p className="lead-actual">
            Last 12 complete months:{' '}
            <button type="button" className="link-button strong" onClick={() => onDrill({ kind: 'last12' })}>
              <Money amount={summary.comparison.trailing_12} currency={currency} />
            </button>
            {/* The change against the 12 months before (<Delta pct={summary.comparison.change_pct} />) is
                switched off for now, along with the year-on-year card. */}
          </p>
        ) : null}

        {/* The headline arrives with a direction: the last 12 complete months. */}
        {last12.length >= 2 && last12.some((row) => row.amount > 0) ? (
          <div className="lead-trend">
            <span className="lbl">Paid each month · click a month for its payments</span>
            <Sparkline
              values={last12.map((row) => row.amount)}
              labels={last12.map((row) => monthLabel(row.month, true))}
              currency={currency}
              onSelect={(i) => onDrill({ kind: 'month', month: last12[i]!.month })}
            />
          </div>
        ) : null}
      </div>

      <div className="lead-side">
        <div className="lead-label">Committed for {year} · to 31 Dec</div>
        <button
          type="button"
          className="forecast-figure lead-button"
          onClick={() => onDrill({ kind: 'forecast', focus: 'all' })}
          aria-label={`Committed for ${year}: ${formatMoney(forecast.total, currency)}. Open the bills still to come.`}
        >
          <span className="forecast-value">{formatMoney(forecast.total, currency)}</span>
          <IconChevronRight size={14} className="split-key-chevron" />
        </button>
        <p className="forecast-note">
          {formatMoney(forecast.paid, currency)} paid + {formatMoney(toCome, currency)} in bills not yet paid
          <span className="forecast-note-sub">Cloud usage counts once billed; it is not predicted.</span>
        </p>

        {/*
          One bar for the year: blue for subscriptions we buy, orange for our own
          products; solid for paid, pale for still to come. A segment under 0.5%
          is not drawn -- it would be a sliver nobody could see or hover.
        */}
        {forecast.total > 0 ? (
          <>
            <div
              className="proportion year-bar"
              role="img"
              aria-label={`Of ${formatMoney(forecast.total, currency)} committed: subscriptions we buy ${formatMoney(split.bought.paid, currency)} paid and ${formatMoney(split.bought.to_come, currency)} to come; our own products ${formatMoney(split.own.paid, currency)} paid and ${formatMoney(split.own.to_come, currency)} to come.`}
            >
              {[
                { key: 'bp', value: split.bought.paid, className: 'bought' },
                { key: 'bt', value: split.bought.to_come, className: 'bought is-to-come' },
                { key: 'op', value: split.own.paid, className: 'internal' },
                { key: 'ot', value: split.own.to_come, className: 'internal is-to-come' },
              ]
                .filter((seg) => seg.value / forecast.total >= 0.005)
                .map((seg) => (
                  <span key={seg.key} className={seg.className} style={{ flexGrow: seg.value }} />
                ))}
            </div>
            <div className="year-bar-key" aria-hidden="true">
              <span><i className="solid" /> paid</span>
              <span><i className="pale" /> still to come</span>
            </div>
          </>
        ) : null}

        <div className="split-key">
          <button
            type="button"
            className="split-key-item"
            onClick={() => onDrill({ kind: 'forecast', focus: 'subscriptions' })}
          >
            <span className="split-key-name">
              <span className="key-swatch" style={{ background: 'var(--series-1)' }} />
              Subscriptions we buy
            </span>
            <span className="split-key-figure">
              {formatMoney(split.bought.total, currency)}
              <span className="split-key-sub">
                {formatShort(split.bought.paid, currency)} paid ·{' '}
                {formatShort(split.bought.to_come, currency)} to come
              </span>
            </span>
            <IconChevronRight size={14} className="split-key-chevron" />
          </button>
          <button
            type="button"
            className="split-key-item"
            onClick={() => onDrill({ kind: 'forecast', focus: 'products' })}
          >
            <span className="split-key-name">
              <span className="key-swatch" style={{ background: 'var(--series-2)' }} />
              Running our own products
            </span>
            <span className="split-key-figure">
              {formatMoney(split.own.total, currency)}
              <span className="split-key-sub">
                {formatShort(split.own.paid, currency)} paid ·{' '}
                {formatShort(split.own.to_come, currency)} to come
              </span>
            </span>
            <IconChevronRight size={14} className="split-key-chevron" />
          </button>
        </div>
      </div>
    </section>
  );
}

/** 'INR', 'INR and USD', 'INR, USD and EUR'. */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// ------------------------------------------------------------------- trend

/**
 * Twelve complete months, stacked by kind of spend.
 *
 * Twelve rather than the full 24 held in the data: at two years the columns
 * were too thin to read and the older half told a story the year-on-year chart
 * beside it already tells. The current month is left out on purpose -- it is
 * still being paid, and a part-month beside full ones reads as a drop that has
 * not happened.
 */
export function TrendCard({ summary, onDrill }: { summary: CeoSummary; onDrill: (view: DrillView) => void }) {
  const currency = summary.reporting_currency;
  const window = summary.paid_by_month.slice(-12);
  const hasUsage = window.some((row) => row.usage > 0);

  const series = hasUsage
    ? [
        { key: 'subscriptions', name: 'Subscriptions', colour: 'var(--series-1)' },
        { key: 'usage', name: 'Cloud usage', colour: 'var(--series-2)' },
      ]
    : [{ key: 'subscriptions', name: 'Subscriptions', colour: 'var(--series-1)' }];

  const points = window.map((row) => ({
    label: monthLabel(row.month),
    // The year makes the label unique and is what the tooltip shows.
    fullLabel: monthLabel(row.month, true),
    values: hasUsage ? [row.subscriptions, row.usage] : [row.subscriptions],
  }));

  return (
    <section className="card">
      <div className="card-head">
        <h2>What we paid, month by month</h2>
        <span className="hint">complete months · click one for its payments</span>
      </div>
      <StackedColumns
        points={points}
        series={series}
        currency={currency}
        onSelect={(i) => onDrill({ kind: 'month', month: window[i]!.month })}
      />
    </section>
  );
}

/**
 * This year to date against the same months last year, as running totals.
 * Built here from the 24 months the summary already holds, so it is the same
 * money as the chart beside it and cannot drift from it.
 */
export function YearCompareCard({ summary }: { summary: CeoSummary }) {
  const currency = summary.reporting_currency;
  const { comparison } = summary;

  const latest = summary.latest_complete_month;
  const currentYear = latest.slice(0, 4);
  const previousYear = String(Number(currentYear) - 1);
  const latestIndex = Number(latest.slice(5, 7)) - 1;

  const byMonth = new Map(summary.paid_by_month.map((row) => [row.month, row.amount]));
  const running = (year: string, through: number): Array<number | null> => {
    let total = 0;
    return MONTH_SHORT.map((_, i) => {
      if (i > through) return null;
      total += byMonth.get(`${year}-${String(i + 1).padStart(2, '0')}`) ?? 0;
      return total;
    });
  };

  const data: CumulativeInput = {
    months: MONTH_SHORT,
    current: running(currentYear, latestIndex),
    // Last year runs the full twelve months: the second line shows where this
    // year is heading, not just where it is.
    previous: running(previousYear, 11),
    currentLabel: currentYear,
    previousLabel: previousYear,
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>This year against last</h2>
        <span className="hint">running total</span>
      </div>
      <CumulativeCompare data={data} currency={currency} />
      {comparison.trailing_12 !== null && comparison.previous_12 !== null ? (
        <div className="compare">
          <div className="compare-item">
            <span className="compare-label">Last 12 months</span>
            <span className="compare-value">
              <Money amount={comparison.trailing_12} currency={currency} />
            </span>
          </div>
          <div className="compare-item is-muted">
            <span className="compare-label">The 12 before</span>
            <span className="compare-value">
              <Money amount={comparison.previous_12} currency={currency} />
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------ concentration

export function BiggestToolsCard({ summary, onDrill }: { summary: CeoSummary; onDrill: (view: DrillView) => void }) {
  const currency = summary.reporting_currency;
  // The whole the shares are shares of: every costed subscription, not just the
  // eight shown, so the percentages say how concentrated the spend really is.
  const whole = summary.by_category.reduce((sum, row) => sum + row.annual_reported, 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Our biggest subscriptions</h2>
        <span className="hint">
          a year each ·{' '}
          <button type="button" className="link-button" onClick={() => onDrill({ kind: 'runrate', focus: 'subscriptions' })}>
            see all
          </button>
        </span>
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
          total={whole > 0 ? whole : undefined}
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
          total={summary.by_category.reduce((sum, row) => sum + row.annual_reported, 0)}
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

export function ProductsCard({ summary, onDrill }: { summary: CeoSummary; onDrill: (view: DrillView) => void }) {
  const currency = summary.reporting_currency;
  const year = summary.year_forecast.year;
  // The same split the headline uses, so a product here and "Running our own
  // products" there are the same money.
  const byProduct = splitYear(summary.paid_items, summary.year_forecast).by_product;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Our products</h2>
        <span className="hint">
          {year} so far · <Link to="/products">Manage</Link>
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
            const part = byProduct.get(entry.product.id) ?? { paid: 0, to_come: 0, total: 0 };
            // Nothing recorded on either side. Showing 0.00 here would say the
            // product is free, when the truth is that nobody has entered its cost.
            const unknown = !hasUsage && !fixedKnown && part.total === 0;
            const paidPct = part.total > 0 ? (part.paid / part.total) * 100 : 0;
            // The most recent cloud bill entered: a fact, where a yearly
            // projection of it would be a guess.
            const bills = summary.paid_items.filter((i) => i.kind === 'usage' && i.product_id === entry.product.id);
            const lastMonth = bills.reduce<string | null>((max, i) => (max === null || i.month > max ? i.month : max), null);
            const lastBill = bills.filter((i) => i.month === lastMonth).reduce((sum, i) => sum + (i.amount_reported ?? 0), 0);
            return (
              <div className="product-block" key={entry.product.id}>
                <div className="product-block-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="product-name">
                      <Link to={`/products/${entry.product.id}`}>{entry.product.name}</Link>
                    </div>
                    <div className="product-meta">
                      {entry.product.owner_name ?? 'No owner set'}
                      {entry.product.status !== 'live' ? ` · ${entry.product.status}` : ''}
                    </div>
                  </div>
                  {unknown ? (
                    <div className="product-cost">
                      <div className="primary" style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                        Not known yet
                      </div>
                      <div className="secondary">no cost recorded</div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="product-cost product-cost-button"
                      onClick={() => onDrill({ kind: 'forecast', focus: 'products' })}
                      aria-label={`${entry.product.name}: ${formatMoney(part.total, currency)} committed in ${year}. See what is paid and what is still to come.`}
                    >
                      <div className="primary">{formatMoney(part.total, currency)}</div>
                      <div className="secondary">
                        committed in {year} <IconChevronRight size={11} />
                      </div>
                    </button>
                  )}
                </div>

                {unknown ? null : (
                  <>
                    <div
                      className="proportion year-bar"
                      role="img"
                      aria-label={`${formatMoney(part.paid, currency)} paid, ${formatMoney(part.to_come, currency)} still to come`}
                    >
                      {part.paid > 0 ? <span className="internal" style={{ flexGrow: paidPct }} /> : null}
                      {part.to_come > 0 ? (
                        <span className="internal is-to-come" style={{ flexGrow: 100 - paidPct }} />
                      ) : null}
                    </div>
                    <dl className="product-stats">
                      <div>
                        <dt>Paid</dt>
                        <dd>{formatShort(part.paid, currency)}</dd>
                      </div>
                      <div>
                        <dt>Bills to come</dt>
                        <dd>{formatShort(part.to_come, currency)}</dd>
                      </div>
                      <div>
                        <dt>Last cloud bill</dt>
                        <dd>
                          {lastMonth ? (
                            <>
                              {formatShort(lastBill, currency)}
                              <span> {monthLabel(lastMonth)}</span>
                            </>
                          ) : (
                            <span>none yet</span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    <div className="product-meta">
                      {entry.last_cost_month
                        ? `Cloud counts up to ${monthLabel(entry.last_cost_month, true)}, the last bill entered; later months join as they are billed.`
                        : 'No cloud bills entered yet.'}
                      {entry.tool_count > 0
                        ? ` Runs on ${entry.tool_count} ${entry.tool_count === 1 ? 'subscription' : 'subscriptions'}.`
                        : ''}
                    </div>
                  </>
                )}

                {entry.cost_entry_due ? (
                  <div>
                    <Link to={`/products/${entry.product.id}`}>
                      <Badge tone="warning">{monthLabel(summary.latest_complete_month, true)} costs not entered</Badge>
                    </Link>
                  </div>
                ) : null}
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
  const listed = summary.idle_tools.reduce((sum, tool) => sum + tool.annual_reported, 0);
  const more = summary.idle_seat_cost - listed;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Seats nobody is using</h2>
        <span className="hint">
          <Link to="/tools">Right-size at renewal</Link>
        </span>
      </div>
      <div className="reclaim">
        <span className="reclaim-value">{formatMoney(summary.idle_seat_cost, currency)}</span>
        <span className="reclaim-note">
          a year across {summary.idle_seat_count} paid{' '}
          {summary.idle_seat_count === 1 ? 'seat' : 'seats'} with nobody on them — already
          recoverable.
        </span>
      </div>
      {summary.idle_tools.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          {summary.idle_tools.map((tool) => (
            <div className="idle-row" key={tool.id}>
              <Link className="idle-name" to={`/tools/${tool.id}`}>
                {tool.label}
              </Link>
              <SeatMeter used={tool.seats_used} purchased={tool.seats_purchased} />
              <span className="idle-cost">{formatMoney(tool.annual_reported, currency)}</span>
            </div>
          ))}
          {more > 0 ? (
            <div className="cell-sub" style={{ paddingTop: 8 }}>
              and {formatMoney(more, currency)} across smaller tools
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ method

/**
 * Amounts left out for want of an exchange rate. This is the one part of "how
 * the figures were made" that must not be quiet, so it sits directly under the
 * headline and only appears when there is something to say.
 */
export function CoverageNotice({ summary }: { summary: CeoSummary }) {
  const currency = summary.reporting_currency;

  if (!summary.fx_available) {
    return (
      <Banner tone="warning">
        <span>
          No exchange rates are stored yet, so anything not already in {currency} is missing from
          these figures. <Link to="/settings">Fetch rates in Settings</Link> to complete them.
        </span>
      </Banner>
    );
  }
  if (summary.gaps.length === 0) return null;

  return (
    <Banner tone="warning">
      <div>
        <strong>Some amounts are missing from these figures.</strong> No exchange rate covered
        them, so they were left out rather than guessed at.{' '}
        <Link to="/settings">Fetch a wider range of rates</Link> to close the gap.
        <div className="gap-list">
          {summary.gaps.map((gap) => (
            <Badge tone="warning" key={`${gap.currency}-${gap.month}`}>
              {gap.currency}
              {gap.month ? ` · ${gap.month}` : ''} · {gap.count}{' '}
              {gap.count === 1 ? 'amount' : 'amounts'}
            </Badge>
          ))}
        </div>
      </div>
    </Banner>
  );
}

/**
 * How the figures were made, as a footer.
 *
 * It stays on the dashboard because the basis of a number is part of the number
 * -- but it is a short paragraph of small type, not a section. The one table
 * that backs a chart is a click away rather than in the way.
 */
export function MethodFooter({ summary, onDrill }: { summary: CeoSummary; onDrill: (view: DrillView) => void }) {
  const currency = summary.reporting_currency;
  const first = summary.rate_months[0];
  const lastRate = summary.rate_months[summary.rate_months.length - 1];

  return (
    <footer className="method">
      <p>
        <strong>How these figures are made.</strong> Amounts not in {currency} are converted at
        European Central Bank reference rates
        {first && lastRate ? ` (${first} to ${lastRate})` : ''}: today&rsquo;s run rate at the
        latest month, past payments at the month they were paid, so a closed year never changes.
        Running cost is subscriptions, licences and cloud only — no staff time — and cloud usage is
        entered monthly and averaged over the last three complete months, so it is an estimate. As
        at {formatDate(summary.today)}.
      </p>
      <details>
        <summary>Paid by year, as figures</summary>
        <div className="table-wrap">
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
                  <td className="cell-primary">
                    <button type="button" className="link-button" onClick={() => onDrill({ kind: 'year', year: row.year })}>
                      {row.year}
                    </button>
                  </td>
                  <td className="num">{formatMoney(row.amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </footer>
  );
}
