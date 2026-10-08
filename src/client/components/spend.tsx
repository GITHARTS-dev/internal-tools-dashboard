import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BarRows, CumulativeCompare, SeatMeter, type CumulativeInput } from './Charts';
import { Badge, Banner, EmptyState } from './ui';
import { IconChevronLeft, IconChevronRight } from './icons';
import type { DrillView } from './drilldown';
import { formatDate } from '../../shared/dates';
import { breakdown, itemsBetween, splitYear, type YearPart } from '../../shared/drilldown';
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
 * The headline: what was spent this year, beside what the year is committed to.
 *
 * Two figures and one small table, and nothing to read. The left figure is a
 * fact; the right one adds the subscription bills still to come by 31 December
 * (cloud usage joins as it is billed -- it is never predicted). The table
 * splits the commitment by whose money it is and how much is already paid.
 * Every figure and row opens the drill-down it summarises.
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
  const forecast = summary.year_forecast;
  const split = splitYear(summary.paid_items, forecast);

  const rows: Array<{ key: 'subscriptions' | 'products'; label: string; colour: string; part: YearPart }> = [
    { key: 'subscriptions', label: 'Subscriptions', colour: 'var(--series-1)', part: split.bought },
    { key: 'products', label: 'Our products', colour: 'var(--series-2)', part: split.own },
  ];

  return (
    <section className="lead" aria-labelledby="lead-heading">
      <div className="lead-main">
        <h2 id="lead-heading" className="lead-label">
          Spent in {year}
        </h2>
        <button
          type="button"
          className="lead-figure lead-button"
          onClick={() => onDrill({ kind: 'year', year })}
          aria-label={`Spent in ${year}: ${formatMoney(thisYear.total, currency)}. Open every payment.`}
        >
          <span className="lead-value">{formatMoney(thisYear.total, currency)}</span>
          <IconChevronRight size={18} className="lead-chevron" />
        </button>

        <dl className="lead-facts">
          <div>
            <dt>Subscriptions</dt>
            <dd>{formatShort(thisYear.subscriptions, currency)}</dd>
          </div>
          <div>
            <dt>Cloud</dt>
            <dd>{formatShort(thisYear.usage, currency)}</dd>
          </div>
        </dl>
      </div>

      <div className="lead-side">
        <h2 className="lead-label">Committed for {year}</h2>
        <button
          type="button"
          className="forecast-figure lead-button"
          onClick={() => onDrill({ kind: 'forecast', focus: 'all' })}
          aria-label={`Committed for ${year}: ${formatMoney(forecast.total, currency)}. Open the bills still to come.`}
        >
          <span className="forecast-value">{formatMoney(forecast.total, currency)}</span>
          <IconChevronRight size={15} className="lead-chevron" />
        </button>

        <table className="lead-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Spend</span>
              </th>
              <th scope="col" className="num">Paid</th>
              <th scope="col" className="num">To come</th>
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} onClick={() => onDrill({ kind: 'forecast', focus: row.key })}>
                <th scope="row">
                  <button
                    type="button"
                    className="lead-row-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDrill({ kind: 'forecast', focus: row.key });
                    }}
                  >
                    <span className="key-swatch" style={{ background: row.colour }} />
                    {row.label}
                  </button>
                </th>
                <td className="num">{formatShort(row.part.paid, currency)}</td>
                <td className="num">{row.part.to_come > 0 ? formatShort(row.part.to_come, currency) : '—'}</td>
                <td className="num strong">{formatShort(row.part.total, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="lead-foot">Cloud is added as each month is billed.</p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ month by month

/**
 * Each month of a calendar year as a row: subscriptions, cloud, total, and a
 * bar for its size.
 *
 * A table rather than a chart, because the question it answers is "how much,
 * exactly, in which month" -- and the bar in each row still shows the shape at
 * a glance, so a separate chart would only repeat it. Built from the same
 * payments as "Spent in" and summed the same way, so the total row equals the
 * headline to the paisa. The current month is shown as it stands, marked so.
 */
export function MonthTableCard({ summary, onDrill }: { summary: CeoSummary; onDrill: (view: DrillView) => void }) {
  const currency = summary.reporting_currency;
  const currentMonth = monthOf(summary.today);
  const currentYear = summary.today.slice(0, 4);
  const firstYear = summary.paid_items.reduce(
    (min, item) => (item.month.slice(0, 4) < min ? item.month.slice(0, 4) : min),
    currentYear,
  );
  const [year, setYear] = useState(currentYear);

  const lastMonth = year === currentYear ? Number(currentMonth.slice(5, 7)) : 12;
  const rows = Array.from({ length: lastMonth }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    return { month, ...breakdown(itemsBetween(summary.paid_items, month, month), currency) };
  });
  const yearTotal = breakdown(itemsBetween(summary.paid_items, `${year}-01`, `${year}-12`), currency);
  const max = Math.max(...rows.map((row) => row.total), 1);
  const hasCloud = rows.some((row) => row.bill_count > 0);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Month by month</h2>
        <span className="hint year-switch">
          <button
            type="button"
            className="btn subtle sm"
            onClick={() => setYear(String(Number(year) - 1))}
            disabled={year <= firstYear}
            aria-label={`Previous year, ${Number(year) - 1}`}
          >
            <IconChevronLeft size={14} />
          </button>
          <span className="year-switch-label">{year}</span>
          <button
            type="button"
            className="btn subtle sm"
            onClick={() => setYear(String(Number(year) + 1))}
            disabled={year >= currentYear}
            aria-label={`Next year, ${Number(year) + 1}`}
          >
            <IconChevronRight size={14} />
          </button>
        </span>
      </div>

      <div className="table-wrap">
        <table className="month-table">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className="month-bar-col">
                <span className="month-key">
                  <span className="key-swatch" style={{ background: 'var(--series-1)' }} /> Subscriptions
                  {hasCloud ? (
                    <>
                      <span className="key-swatch" style={{ background: 'var(--series-2)' }} /> Cloud
                    </>
                  ) : null}
                </span>
              </th>
              <th scope="col" className="num">Subscriptions</th>
              <th scope="col" className="num">Cloud</th>
              <th scope="col" className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const empty = row.items.length === 0;
              return (
                <tr
                  key={row.month}
                  className={empty ? 'is-empty' : undefined}
                  onClick={empty ? undefined : () => onDrill({ kind: 'month', month: row.month })}
                >
                  <th scope="row">
                    {empty ? (
                      monthLabel(row.month)
                    ) : (
                      <button
                        type="button"
                        className="lead-row-button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDrill({ kind: 'month', month: row.month });
                        }}
                      >
                        {monthLabel(row.month)}
                      </button>
                    )}
                    {row.month === currentMonth ? <span className="cell-sub"> so far</span> : null}
                  </th>
                  <td className="month-bar-col" aria-hidden="true">
                    <span className="month-bar" style={{ width: `${(row.total / max) * 100}%` }}>
                      {row.subscriptions > 0 ? <span className="bought" style={{ flexGrow: row.subscriptions }} /> : null}
                      {row.usage > 0 ? <span className="cloud" style={{ flexGrow: row.usage }} /> : null}
                    </span>
                  </td>
                  <td className="num">{row.subscriptions > 0 ? formatMoney(row.subscriptions, currency) : '—'}</td>
                  <td className="num">{row.usage > 0 ? formatMoney(row.usage, currency) : '—'}</td>
                  <td className="num strong">{empty ? '—' : formatMoney(row.total, currency)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{year === currentYear ? `${year} so far` : year}</th>
              <td className="month-bar-col" />
              <td className="num">{formatMoney(yearTotal.subscriptions, currency)}</td>
              <td className="num">{formatMoney(yearTotal.usage, currency)}</td>
              <td className="num strong">{formatMoney(yearTotal.total, currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
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
  // The same split the headline uses, so a product here and "Our products"
  // there are the same money.
  const byProduct = splitYear(summary.paid_items, summary.year_forecast).by_product;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Our products</h2>
        <span className="hint">
          <button type="button" className="link-button" onClick={() => onDrill({ kind: 'forecast', focus: 'products' })}>
            {year} detail
          </button>
          {' · '}
          <Link to="/products">Manage</Link>
        </span>
      </div>

      {summary.products.length === 0 ? (
        <EmptyState title="No internal products yet" compact>
          Add one on the <Link to="/products">Our products</Link> screen.
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="compact-table">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col" className="num">Spent {year}</th>
                <th scope="col" className="num">Last cloud bill</th>
              </tr>
            </thead>
            <tbody>
              {summary.products.map((entry) => {
                const part = byProduct.get(entry.product.id);
                // The most recent cloud bill entered: a fact, where a yearly
                // projection of it would be a guess.
                const bills = summary.paid_items.filter((i) => i.kind === 'usage' && i.product_id === entry.product.id);
                const lastMonth = bills.reduce<string | null>(
                  (max, i) => (max === null || i.month > max ? i.month : max),
                  null,
                );
                const lastBill = bills
                  .filter((i) => i.month === lastMonth)
                  .reduce((sum, i) => sum + (i.amount_reported ?? 0), 0);
                return (
                  <tr key={entry.product.id}>
                    <td>
                      <Link className="cell-primary" to={`/products/${entry.product.id}`}>
                        {entry.product.name}
                      </Link>
                      {entry.cost_entry_due ? (
                        <div>
                          <Badge tone="warning">{monthLabel(summary.latest_complete_month)} not entered</Badge>
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      {part && part.total > 0 ? formatMoney(part.total, currency) : <span className="cell-sub">—</span>}
                    </td>
                    <td className="num">
                      {lastMonth ? (
                        <>
                          {formatShort(lastBill, currency)}
                          <div className="cell-sub">{monthLabel(lastMonth, true)}</div>
                        </>
                      ) : (
                        <span className="cell-sub">none yet</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
          <strong>No exchange rates yet</strong> — amounts not in {currency} are left out.{' '}
          <Link to="/settings">Fetch rates</Link>
        </span>
      </Banner>
    );
  }
  if (summary.gaps.length === 0) return null;

  const count = summary.gaps.reduce((sum, gap) => sum + gap.count, 0);
  return (
    <Banner tone="warning">
      <span>
        <strong>
          {count} {count === 1 ? 'amount' : 'amounts'} left out
        </strong>{' '}
        — no exchange rate for{' '}
        {summary.gaps.map((gap) => `${gap.currency}${gap.month ? ` ${gap.month}` : ''}`).join(', ')}.{' '}
        <Link to="/settings">Fetch rates</Link>
      </span>
    </Banner>
  );
}

/** How the figures are made, in two lines, with the paid-by-year table a click away. */
export function MethodFooter({ summary, onDrill }: { summary: CeoSummary; onDrill: (view: DrillView) => void }) {
  const currency = summary.reporting_currency;

  return (
    <footer className="method">
      <p>
        Converted to {currency} at ECB monthly rates — each payment at the rate of its own month. Cloud
        costs are entered monthly; staff time is not included. As at {formatDate(summary.today)}.
      </p>
      <details>
        <summary>Paid by year</summary>
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
