import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Banner, EmptyState } from './ui';
import { IconChevronLeft, IconChevronRight, IconClose } from './icons';
import { addMonthsToYearMonth, monthOf } from '../../shared/fx';
import { formatDate } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import { breakdown, itemsBetween } from '../../shared/drilldown';
import type { CeoSummary, InternalProductCost, RunRateItem, SpendItem, YearForecastLine } from '../../shared/types';

/**
 * Drill-downs: any figure on the dashboard opened up into what it is made of.
 *
 * Three kinds, because the dashboard shows three kinds of money:
 *
 *   Paid      a year, a month or the last twelve: every payment marked paid and
 *             every cloud bill entered, as recorded and in the reporting
 *             currency, with the split by currency.
 *   Forecast  this calendar year: paid so far, plus every bill still to come
 *             before 31 December and the cloud usage still to be billed.
 *   Run rate  a full year at today's prices: every subscription at its price,
 *             and each product's cloud usage as the average it actually is,
 *             with the months it was taken over. For comparing tools.
 *
 * The open view lives in the URL (`?view=month:2026-09`), so the browser's Back
 * closes it, a drill-down can be linked to, and following a link out of it to a
 * tool and coming back reopens it where it was.
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CYCLE_WORD: Record<string, string> = {
  monthly: 'a month',
  quarterly: 'a quarter',
  annual: 'a year',
  one_time: 'once',
  custom: 'custom cycle',
};

function shortMonth(month: string, withYear = true): string {
  const name = MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${name} ${month.slice(0, 4)}` : name;
}

function longMonth(month: string): string {
  return `${MONTH_LONG[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

// ------------------------------------------------------------------ state

export type DrillView =
  | { kind: 'year'; year: string }
  | { kind: 'month'; month: string }
  | { kind: 'last12' }
  | { kind: 'forecast'; focus: Focus }
  | { kind: 'runrate'; focus: Focus };

/** Everything, or one side of the split: subscriptions we buy, or our own products. */
type Focus = 'all' | 'subscriptions' | 'products';

/** Which side of the split a line belongs to: our own products when it carries a product id. */
function inFocus(focus: Focus, productId: string | null): boolean {
  if (focus === 'all') return true;
  return (focus === 'products') === (productId !== null);
}

export function viewKey(view: DrillView): string {
  switch (view.kind) {
    case 'year':
      return `year:${view.year}`;
    case 'month':
      return `month:${view.month}`;
    case 'last12':
      return 'last12';
    case 'forecast':
    case 'runrate':
      return view.focus === 'all' ? view.kind : `${view.kind}:${view.focus}`;
  }
}

export function parseView(raw: string | null): DrillView | null {
  if (!raw) return null;
  if (raw === 'last12') return { kind: 'last12' };
  const split = /^(forecast|runrate)(?::(subscriptions|products))?$/.exec(raw);
  if (split) return { kind: split[1] as 'forecast' | 'runrate', focus: (split[2] as Focus | undefined) ?? 'all' };
  const year = /^year:(\d{4})$/.exec(raw);
  if (year) return { kind: 'year', year: year[1]! };
  const month = /^month:(\d{4}-(0[1-9]|1[0-2]))$/.exec(raw);
  if (month) return { kind: 'month', month: month[1]! };
  return null;
}

/**
 * Open, switch and close the drill-down. Opening pushes a history entry, so
 * Back closes it; moving between months inside one replaces the entry, so Back
 * does not have to step through every month that was looked at.
 */
export function useDrill() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const view = parseView(params.get('view'));
  const pushed = (location.state as { drill?: boolean } | null)?.drill === true;

  const open = useCallback(
    (next: DrillView) => {
      const copy = new URLSearchParams(params);
      copy.set('view', viewKey(next));
      setParams(copy, { state: { drill: true } });
    },
    [params, setParams],
  );

  const swap = useCallback(
    (next: DrillView) => {
      const copy = new URLSearchParams(params);
      copy.set('view', viewKey(next));
      setParams(copy, { replace: true, state: location.state });
    },
    [params, setParams, location.state],
  );

  const close = useCallback(() => {
    if (pushed) {
      navigate(-1);
      return;
    }
    const copy = new URLSearchParams(params);
    copy.delete('view');
    setParams(copy, { replace: true });
  }, [pushed, navigate, params, setParams]);

  return { view, open, swap, close };
}

// ------------------------------------------------------------------ sheet

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A panel over the right of the page. Portaled to the body for the same reason
 * the chart tooltips are: a backdrop-filter on any ancestor would make `fixed`
 * mean that panel rather than the viewport.
 */
function Sheet({
  kicker,
  title,
  subtitle,
  onClose,
  nav,
  children,
}: {
  kicker: string;
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  nav?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      // Keep Tab inside the panel while it is open.
      if (event.key === 'Tab' && panel.current) {
        const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="sheet-root">
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        ref={panel}
        tabIndex={-1}
      >
        <header className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <div className="lbl">{kicker}</div>
            <h2 id="sheet-title" className="sheet-title">
              {title}
            </h2>
            {subtitle ? <div className="sheet-subtitle">{subtitle}</div> : null}
          </div>
          <div className="sheet-actions">
            {nav}
            <button type="button" className="btn subtle sm" onClick={onClose} aria-label="Close">
              <IconClose size={16} />
            </button>
          </div>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// -------------------------------------------------------------- the root

/** Renders whichever drill-down the URL names, or nothing. */
export function Drilldown({ summary }: { summary: CeoSummary }) {
  const { view, swap, close } = useDrill();
  if (!view) return null;

  const currentMonth = monthOf(summary.today);
  const currentYear = summary.today.slice(0, 4);

  if (view.kind === 'forecast') {
    return <YearForecastSheet summary={summary} focus={view.focus} onClose={close} onSwap={swap} />;
  }
  if (view.kind === 'runrate') {
    return <RunRateSheet summary={summary} focus={view.focus} onClose={close} />;
  }

  if (view.kind === 'month') {
    const earliest = summary.paid_items.reduce(
      (min, item) => (item.month < min ? item.month : min),
      addMonthsToYearMonth(currentMonth, -23),
    );
    const prev = addMonthsToYearMonth(view.month, -1);
    const next = addMonthsToYearMonth(view.month, 1);
    const partial = view.month === currentMonth;

    return (
      <PaidSheet
        summary={summary}
        from={view.month}
        to={view.month}
        title={longMonth(view.month)}
        subtitle={
          partial
            ? `This month is not over: only what has been paid so far, up to ${formatDate(summary.today)}.`
            : 'Every payment marked paid in this month, and the cloud bills entered for it.'
        }
        onClose={close}
        onOpenMonth={null}
        nav={
          <>
            <button
              type="button"
              className="btn subtle sm"
              onClick={() => swap({ kind: 'month', month: prev })}
              disabled={prev < earliest}
              aria-label={`Previous month, ${longMonth(prev)}`}
            >
              <IconChevronLeft size={15} />
            </button>
            <button
              type="button"
              className="btn subtle sm"
              onClick={() => swap({ kind: 'month', month: next })}
              disabled={next > currentMonth}
              aria-label={`Next month, ${longMonth(next)}`}
            >
              <IconChevronRight size={15} />
            </button>
          </>
        }
      />
    );
  }

  const openMonth = (month: string) => swap({ kind: 'month', month });

  if (view.kind === 'last12') {
    const from = summary.comparison.from ?? addMonthsToYearMonth(currentMonth, -12);
    const to = summary.comparison.to ?? addMonthsToYearMonth(currentMonth, -1);
    return (
      <PaidSheet
        summary={summary}
        from={from}
        to={to}
        title="The last 12 complete months"
        subtitle={`${longMonth(from)} to ${longMonth(to)}. This month is left out until it is over.`}
        onClose={close}
        onOpenMonth={openMonth}
      />
    );
  }

  const isCurrent = view.year === currentYear;
  const from = `${view.year}-01`;
  const to = isCurrent ? currentMonth : `${view.year}-12`;
  return (
    <PaidSheet
      summary={summary}
      from={from}
      to={to}
      title={isCurrent ? `${view.year} so far` : view.year}
      subtitle={
        isCurrent
          ? `1 Jan to ${formatDate(summary.today)}: every payment marked paid, and every cloud bill entered.`
          : `Every payment marked paid in ${view.year}, and every cloud bill entered for it.`
      }
      onClose={close}
      onOpenMonth={openMonth}
      nav={
        <>
          <button
            type="button"
            className="btn subtle sm"
            onClick={() => swap({ kind: 'year', year: String(Number(view.year) - 1) })}
            disabled={!summary.paid_items.some((item) => item.month < from)}
            aria-label={`Previous year, ${Number(view.year) - 1}`}
          >
            <IconChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="btn subtle sm"
            onClick={() => swap({ kind: 'year', year: String(Number(view.year) + 1) })}
            disabled={view.year >= currentYear}
            aria-label={`Next year, ${Number(view.year) + 1}`}
          >
            <IconChevronRight size={15} />
          </button>
        </>
      }
    />
  );
}

// ------------------------------------------------------------- paid money

function PaidSheet({
  summary,
  from,
  to,
  title,
  subtitle,
  onClose,
  onOpenMonth,
  nav,
}: {
  summary: CeoSummary;
  from: string;
  to: string;
  title: string;
  subtitle: string;
  onClose: () => void;
  /** Lets a month heading in a longer period open that month; null in a month view. */
  onOpenMonth: ((month: string) => void) | null;
  nav?: ReactNode;
}) {
  const currency = summary.reporting_currency;
  const data = breakdown(itemsBetween(summary.paid_items, from, to), currency);
  const foreign = data.by_currency.some((line) => line.currency !== currency);

  const counts = [
    data.payment_count > 0 ? `${data.payment_count} ${data.payment_count === 1 ? 'payment' : 'payments'}` : null,
    data.bill_count > 0 ? `${data.bill_count} cloud ${data.bill_count === 1 ? 'bill' : 'bills'}` : null,
  ].filter(Boolean);

  return (
    <Sheet kicker="Actually paid" title={title} subtitle={subtitle} onClose={onClose} nav={nav}>
      {data.items.length === 0 ? (
        <EmptyState title="Nothing recorded as paid" compact>
          A subscription counts once its payment is marked paid on the tool's page, and cloud usage
          once a month's bill is entered on the product's page.
        </EmptyState>
      ) : (
        <>
          <div className="drill-total">
            <span className="drill-value">{formatMoney(data.total, currency)}</span>
            <span className="drill-note">{counts.join(' and ')}</span>
          </div>

          <div className="drill-split">
            <div className="drill-split-item">
              <span className="key-swatch" style={{ background: 'var(--series-1)' }} />
              <span>Subscriptions</span>
              <strong>{formatMoney(data.subscriptions, currency)}</strong>
            </div>
            {/* Only when bills were entered: a zero here would read as "free", not "none recorded". */}
            {data.bill_count > 0 ? (
              <div className="drill-split-item">
                <span className="key-swatch" style={{ background: 'var(--series-2)' }} />
                <span>Cloud usage, our products</span>
                <strong>{formatMoney(data.usage, currency)}</strong>
              </div>
            ) : null}
          </div>

          {data.unconverted > 0 ? (
            <Banner tone="warning">
              <span>
                {data.unconverted} {data.unconverted === 1 ? 'amount is' : 'amounts are'} not in
                the total: no exchange rate covered {data.unconverted === 1 ? 'it' : 'them'}.{' '}
                <Link to="/settings">Fetch rates in Settings</Link>.
              </span>
            </Banner>
          ) : null}

          <section className="drill-section">
            <h3 className="drill-h">By currency</h3>
            <p className="drill-sub">
              {foreign
                ? `What was paid in each currency, and what it came to in ${currency}. Each amount is converted at the ECB rate of the month it belongs to.`
                : `Everything here was paid in ${currency}, so nothing was converted.`}
            </p>
            <div className="table-wrap drill-table">
              <table>
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th className="num">As paid</th>
                    <th className="num">In {currency}</th>
                    <th className="num">Lines</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_currency.map((line) => (
                    <tr key={line.currency}>
                      <td className="cell-primary">{line.currency}</td>
                      <td className="num">{formatMoney(line.amount, line.currency)}</td>
                      <td className="num">
                        {line.unconverted === line.count ? (
                          <Badge tone="warning">No rate</Badge>
                        ) : (
                          <>
                            {formatMoney(line.reported, currency)}
                            {line.unconverted > 0 ? (
                              <div className="cell-sub">{line.unconverted} without a rate left out</div>
                            ) : null}
                          </>
                        )}
                      </td>
                      <td className="num">{line.count}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="cell-primary">Total</td>
                    <td />
                    <td className="num cell-primary">{formatMoney(data.total, currency)}</td>
                    <td className="num">{data.items.length}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="drill-section">
            <h3 className="drill-h">Every payment and bill</h3>
            <ItemTable items={data.items} currency={currency} single={from === to} onOpenMonth={onOpenMonth} />
          </section>
        </>
      )}
    </Sheet>
  );
}

function ItemTable({
  items,
  currency,
  single,
  onOpenMonth,
}: {
  items: SpendItem[];
  currency: string;
  single: boolean;
  onOpenMonth: ((month: string) => void) | null;
}) {
  // Grouped by month when the period spans several, each with its own subtotal.
  const months: Array<{ month: string; items: SpendItem[]; total: number }> = [];
  for (const item of items) {
    let group = months[months.length - 1];
    if (!group || group.month !== item.month) {
      group = { month: item.month, items: [], total: 0 };
      months.push(group);
    }
    group.items.push(item);
    group.total += item.amount_reported ?? 0;
  }

  return (
    <div className="table-wrap drill-table">
      <table>
        <thead>
          <tr>
            <th>{single ? 'Paid' : 'When'}</th>
            <th>What</th>
            <th className="num">As paid</th>
            <th className="num">In {currency}</th>
          </tr>
        </thead>
        <tbody>
          {months.map((group) => (
            <MonthRows
              key={group.month}
              month={group.month}
              total={group.total}
              items={group.items}
              currency={currency}
              showHeading={!single}
              onOpenMonth={onOpenMonth}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthRows({
  month,
  total,
  items,
  currency,
  showHeading,
  onOpenMonth,
}: {
  month: string;
  total: number;
  items: SpendItem[];
  currency: string;
  showHeading: boolean;
  onOpenMonth: ((month: string) => void) | null;
}) {
  return (
    <>
      {showHeading ? (
        <tr className="drill-month">
          <td colSpan={3}>
            {onOpenMonth ? (
              <button type="button" className="link-button" onClick={() => onOpenMonth(month)}>
                {longMonth(month)}
                <IconChevronRight size={13} />
              </button>
            ) : (
              longMonth(month)
            )}
          </td>
          <td className="num">{formatMoney(total, currency)}</td>
        </tr>
      ) : null}
      {items.map((item) => (
        <tr key={`${item.kind}-${item.id}`}>
          <td className="drill-when">
            {item.date ? formatDate(item.date) : <span className="cell-sub">{shortMonth(item.month)} bill</span>}
          </td>
          <td>
            <div className="cell-primary">
              {item.tool_id ? (
                <Link to={`/tools/${item.tool_id}`}>{item.label}</Link>
              ) : item.product_id ? (
                <Link to={`/products/${item.product_id}`}>{item.label}</Link>
              ) : (
                item.label
              )}
            </div>
            <div className="cell-sub">
              <span
                className="key-swatch inline"
                style={{ background: item.kind === 'usage' ? 'var(--series-2)' : 'var(--series-1)' }}
              />
              {item.kind === 'usage' ? 'Cloud usage' : 'Subscription'}
              {item.detail ? ` · ${item.detail}` : ''}
            </div>
          </td>
          <td className="num">{formatMoney(item.amount, item.currency)}</td>
          <td className="num">
            {item.amount_reported === null ? (
              <Badge tone="warning">No rate</Badge>
            ) : (
              <>
                {formatMoney(item.amount_reported, currency)}
                {item.rate_month ? <div className="cell-sub">at {shortMonth(item.rate_month)} rate</div> : null}
              </>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- forecast

const LINE_KIND: Record<YearForecastLine['kind'], string> = {
  overdue: 'Overdue',
  scheduled: 'Scheduled',
  renewal: 'Next bill',
};

/** The month after a product's last entered bill: where its unknown cloud usage starts. */
function cloudGapFrom(entry: InternalProductCost, today: string): string | null {
  if (entry.product.status === 'retired' || !entry.last_cost_month) return null;
  const next = addMonthsToYearMonth(entry.last_cost_month, 1);
  return next.slice(0, 4) === today.slice(0, 4) ? next : null;
}

function YearForecastSheet({
  summary,
  focus,
  onClose,
  onSwap,
}: {
  summary: CeoSummary;
  focus: Focus;
  onClose: () => void;
  onSwap: (view: DrillView) => void;
}) {
  const currency = summary.reporting_currency;
  const forecast = summary.year_forecast;
  const year = forecast.year;

  const lines = forecast.lines.filter((line) => inFocus(focus, line.product_id));
  const paid = breakdown(
    itemsBetween(summary.paid_items, `${year}-01`, `${year}-12`).filter((item) => inFocus(focus, item.product_id)),
    currency,
  ).total;
  const overdueLines = lines.filter((l) => l.kind === 'overdue');
  const comingLines = lines.filter((l) => l.kind !== 'overdue');
  const total = (list: YearForecastLine[]) => list.reduce((s, l) => s + (l.amount_reported ?? 0), 0);
  const overdue = total(overdueLines);
  const coming = total(comingLines);
  const missingRate = lines.filter((l) => l.amount_reported === null).length;

  // Products whose cloud usage for the rest of the year is not known yet.
  const cloudGaps =
    focus === 'subscriptions'
      ? []
      : summary.products
          .map((entry) => ({ entry, from: cloudGapFrom(entry, summary.today) }))
          .filter((row): row is { entry: InternalProductCost; from: string } => row.from !== null);

  const title =
    focus === 'subscriptions'
      ? `Subscriptions we buy in ${year}`
      : focus === 'products'
        ? `Running our own products in ${year}`
        : `Committed for ${year}`;

  return (
    <Sheet
      kicker={`To 31 Dec ${year}`}
      title={title}
      subtitle="What has been paid so far, plus every subscription bill still to come before the year ends: known amounts on known dates. Cloud usage still to be billed is not included, because it changes with use."
      onClose={onClose}
    >
      <div className="drill-total">
        <span className="drill-value">{formatMoney(paid + overdue + coming, currency)}</span>
        <span className="drill-note">
          {formatMoney(paid, currency)} paid + {formatMoney(overdue + coming, currency)} in bills not yet paid
        </span>
      </div>

      <div className="drill-parts">
        <button type="button" className="drill-part" onClick={() => onSwap({ kind: 'year', year })}>
          <span className="drill-part-label">Paid so far</span>
          <strong>{formatMoney(paid, currency)}</strong>
          <span className="drill-part-more">
            every payment <IconChevronRight size={12} />
          </span>
        </button>
        <div className="drill-part">
          <span className="drill-part-label">Overdue</span>
          <strong>{formatMoney(overdue, currency)}</strong>
          <span className="drill-part-more">
            {overdueLines.length} {overdueLines.length === 1 ? 'bill' : 'bills'} past due
          </span>
        </div>
        <div className="drill-part">
          <span className="drill-part-label">Bills still to come</span>
          <strong>{formatMoney(coming, currency)}</strong>
          <span className="drill-part-more">
            {comingLines.length} before 31 Dec
          </span>
        </div>
      </div>

      {cloudGaps.length > 0 ? (
        <div className="drill-note-box">
          <strong>Cloud usage after the last bill entered is not included.</strong>{' '}
          {cloudGaps
            .map(({ entry, from }) => `${entry.product.name} from ${shortMonth(from, false)}`)
            .join(', ')}
          . It changes month to month, so it is not predicted; each month joins the total once its bill
          is entered on the product's page.
        </div>
      ) : null}

      {focus !== 'products' && forecast.undated_tools.length > 0 ? (
        <Banner tone="warning">
          <span>
            <strong>
              {forecast.undated_tools.length} {forecast.undated_tools.length === 1 ? 'tool has' : 'tools have'} no
              renewal date,
            </strong>{' '}
            so {forecast.undated_tools.length === 1 ? 'its bills' : 'their bills'} this year cannot be placed and
            {forecast.undated_tools.length === 1 ? ' is' : ' are'} not included:{' '}
            {forecast.undated_tools.map((tool, i) => (
              <span key={tool.tool_id}>
                {i > 0 ? ', ' : ''}
                <Link to={`/tools/${tool.tool_id}`}>{tool.label}</Link>
              </span>
            ))}
            . Add a renewal date to include {forecast.undated_tools.length === 1 ? 'it' : 'them'}.
          </span>
        </Banner>
      ) : null}

      {missingRate > 0 ? (
        <Banner tone="warning">
          <span>
            {missingRate} {missingRate === 1 ? 'amount is' : 'amounts are'} not included: no exchange rate
            covered {missingRate === 1 ? 'it' : 'them'}. <Link to="/settings">Fetch rates in Settings</Link>.
          </span>
        </Banner>
      ) : null}

      {overdueLines.length > 0 ? (
        <section className="drill-section">
          <h3 className="drill-h">
            Overdue
            <span className="drill-h-figure">{formatMoney(overdue, currency)}</span>
          </h3>
          <p className="drill-sub">
            Past their due date and not marked paid. If one was paid, mark it paid on the tool's page and it
            moves to paid; the total stays the same.
          </p>
          <ForecastLineTable lines={overdueLines} currency={currency} />
        </section>
      ) : null}

      {comingLines.length > 0 ? (
        <section className="drill-section">
          <h3 className="drill-h">
            Bills still to come
            <span className="drill-h-figure">{formatMoney(coming, currency)}</span>
          </h3>
          <p className="drill-sub">
            Every subscription bill from today to 31 December, on its billing date at the price in effect
            then. Scheduled ones are already in the payment history; the rest are added as their dates come
            into view. A yearly tool counts once, in the month it renews.
          </p>
          <ForecastLineTable lines={comingLines} currency={currency} />
        </section>
      ) : null}

      {lines.length === 0 ? (
        <EmptyState title="No bills left this year" compact>
          Nothing overdue, and no subscription bills between today and 31 December.
        </EmptyState>
      ) : null}

      <section className="drill-section drill-compare">
        <h3 className="drill-h">
          For comparison: a full year at today's prices
          <span className="drill-h-figure">
            {formatMoney(
              focus === 'subscriptions'
                ? summary.subscriptions.annual_reported
                : focus === 'products'
                  ? summary.internal.annual_reported
                  : summary.total_annual_reported,
              currency,
            )}
          </span>
        </h3>
        <p className="drill-sub">
          Twelve months of every subscription at its current price, plus cloud at its recent average. It
          answers "what does what we run cost per year", which is useful for comparing tools — not what{' '}
          {year} will cost.{' '}
          <button type="button" className="link-button" onClick={() => onSwap({ kind: 'runrate', focus })}>
            See it line by line
          </button>
        </p>
      </section>
    </Sheet>
  );
}

function ForecastLineTable({ lines, currency }: { lines: YearForecastLine[]; currency: string }) {
  return (
    <div className="table-wrap drill-table">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th className="num">As billed</th>
            <th className="num">In {currency}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.kind}-${line.id}`}>
              <td className="drill-when">{formatDate(line.date)}</td>
              <td>
                <div className="cell-primary">
                  {line.tool_id ? (
                    <Link to={`/tools/${line.tool_id}`}>{line.label}</Link>
                  ) : line.product_id ? (
                    <Link to={`/products/${line.product_id}`}>{line.label}</Link>
                  ) : (
                    line.label
                  )}
                </div>
                <div className="cell-sub">
                  {line.kind === 'overdue' ? <Badge tone="critical">Overdue</Badge> : LINE_KIND[line.kind]}
                  {line.detail ? ` · ${line.detail}` : ''}
                </div>
              </td>
              <td className="num">{formatMoney(line.amount, line.currency)}</td>
              <td className="num">
                {line.amount_reported === null ? (
                  <Badge tone="warning">No rate</Badge>
                ) : (
                  formatMoney(line.amount_reported, currency)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- run rate

function RunRateSheet({
  summary,
  focus,
  onClose,
}: {
  summary: CeoSummary;
  focus: Focus;
  onClose: () => void;
}) {
  const currency = summary.reporting_currency;
  const rateMonth = summary.rate_months[summary.rate_months.length - 1] ?? null;
  const bought = summary.run_rate_items.filter((item) => item.product_id === null);
  const productIds = new Set(summary.products.map((p) => p.product.id));
  const orphanProductTools = summary.run_rate_items.filter(
    (item) => item.product_id !== null && !productIds.has(item.product_id),
  );

  useEffect(() => {
    if (focus === 'all') return;
    document.getElementById(`runrate-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  // By currency: every subscription at its price, plus usage, which is entered
  // per month and already converted.
  const byCurrency = new Map<string, { amount: number; reported: number; missing: number }>();
  for (const item of summary.run_rate_items) {
    const line = byCurrency.get(item.currency) ?? { amount: 0, reported: 0, missing: 0 };
    line.amount += item.annual;
    if (item.annual_reported === null) line.missing += 1;
    else line.reported += item.annual_reported;
    byCurrency.set(item.currency, line);
  }
  const usageAnnual = summary.internal.usage_annual_reported;

  return (
    <Sheet
      kicker="For comparison, not this year's spend"
      title="A full year at today's prices"
      subtitle={
        <>
          Every active subscription for twelve months at its current price, plus each product's
          cloud usage at its recent monthly average × 12
          {rateMonth ? `, converted at ${shortMonth(rateMonth)} exchange rates` : ''}. Useful for
          comparing tools and products; what this year will actually cost is the forecast on the
          dashboard.
        </>
      }
      onClose={onClose}
    >
      <div className="drill-total">
        <span className="drill-value">{formatMoney(summary.total_annual_reported, currency)}</span>
        <span className="drill-note">a year · {formatMoney(summary.total_monthly_reported, currency)} a month</span>
      </div>

      <section className="drill-section" id="runrate-subscriptions">
        <h3 className="drill-h">
          <span className="key-swatch" style={{ background: 'var(--series-1)' }} />
          Subscriptions we buy
          <span className="drill-h-figure">{formatMoney(summary.subscriptions.annual_reported, currency)}</span>
        </h3>
        <p className="drill-sub">Committed: these are priced, so a year of each is arithmetic, not a guess.</p>
        <RunRateTable items={bought} currency={currency} />
      </section>

      <section className="drill-section" id="runrate-products">
        <h3 className="drill-h">
          <span className="key-swatch" style={{ background: 'var(--series-2)' }} />
          Running our own products
          <span className="drill-h-figure">{formatMoney(summary.internal.annual_reported, currency)}</span>
        </h3>
        <p className="drill-sub">
          The subscriptions a product runs on, plus its cloud usage. Usage varies month to month, so
          it is the average of the last three complete months that have a bill entered, times 12 —
          an estimate.
        </p>
        {summary.products.length === 0 ? (
          <EmptyState title="No internal products yet" compact />
        ) : (
          summary.products.map((entry) => (
            <ProductForecast
              key={entry.product.id}
              entry={entry}
              items={summary.run_rate_items.filter((item) => item.product_id === entry.product.id)}
              currency={currency}
            />
          ))
        )}
        {orphanProductTools.length > 0 ? <RunRateTable items={orphanProductTools} currency={currency} /> : null}
      </section>

      <section className="drill-section">
        <h3 className="drill-h">By currency</h3>
        <p className="drill-sub">A year of every subscription in the currency it is priced in, and in {currency}.</p>
        <div className="table-wrap drill-table">
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">A year, as priced</th>
                <th className="num">In {currency}</th>
              </tr>
            </thead>
            <tbody>
              {[...byCurrency.entries()]
                .sort((a, b) => b[1].reported - a[1].reported)
                .map(([cur, line]) => (
                  <tr key={cur}>
                    <td className="cell-primary">{cur}</td>
                    <td className="num">{formatMoney(line.amount, cur)}</td>
                    <td className="num">
                      {formatMoney(line.reported, currency)}
                      {line.missing > 0 ? <div className="cell-sub">{line.missing} without a rate left out</div> : null}
                    </td>
                  </tr>
                ))}
              {usageAnnual !== null ? (
                <tr>
                  <td className="cell-primary">
                    Cloud usage
                    <div className="cell-sub">entered monthly, converted per month</div>
                  </td>
                  <td className="num">—</td>
                  <td className="num">{formatMoney(usageAnnual, currency)}</td>
                </tr>
              ) : null}
            </tbody>
            <tfoot>
              <tr>
                <td className="cell-primary">Total</td>
                <td />
                <td className="num cell-primary">{formatMoney(summary.total_annual_reported, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </Sheet>
  );
}

function RunRateTable({ items, currency }: { items: RunRateItem[]; currency: string }) {
  if (items.length === 0) return <p className="drill-sub">None.</p>;
  return (
    <div className="table-wrap drill-table">
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th className="num">Price</th>
            <th className="num">A year</th>
            <th className="num">In {currency}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.tool_id}>
              <td>
                <div className="cell-primary">
                  <Link to={`/tools/${item.tool_id}`}>{item.label}</Link>
                </div>
                {item.vendor ? <div className="cell-sub">{item.vendor}</div> : null}
              </td>
              <td className="num">
                {formatMoney(item.cost_amount, item.currency)}
                <div className="cell-sub">{CYCLE_WORD[item.billing_cycle] ?? item.billing_cycle}</div>
              </td>
              <td className="num">{formatMoney(item.annual, item.currency)}</td>
              <td className="num">
                {item.annual_reported === null ? (
                  <Badge tone="warning">No rate</Badge>
                ) : (
                  formatMoney(item.annual_reported, currency)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductForecast({
  entry,
  items,
  currency,
}: {
  entry: InternalProductCost;
  items: RunRateItem[];
  currency: string;
}) {
  const counted = entry.usage_window.filter((m) => m.amount !== null);

  return (
    <div className="drill-product">
      <div className="drill-product-head">
        <Link to={`/products/${entry.product.id}`} className="cell-primary">
          {entry.product.name}
        </Link>
        <span className="drill-h-figure">
          {entry.annual_reported === null ? 'Not known' : formatMoney(entry.annual_reported, currency)}
          <span className="cell-sub"> a year</span>
        </span>
      </div>

      {items.length > 0 ? <RunRateTable items={items} currency={currency} /> : null}

      <div className="drill-usage">
        <div className="drill-usage-title">Cloud usage</div>
        {entry.usage_monthly_reported === null ? (
          <p className="drill-sub" style={{ margin: 0 }}>
            No bill entered for {entry.usage_window.map((m) => shortMonth(m.month, false)).join(', ')}, so
            no usage is counted in the forecast.
          </p>
        ) : (
          <>
            <ol className="drill-usage-months">
              {entry.usage_window.map((m) => (
                <li key={m.month} className={m.amount === null ? 'is-missing' : undefined}>
                  <span>{shortMonth(m.month)}</span>
                  <span>
                    {m.amount !== null
                      ? formatMoney(m.amount, currency)
                      : m.entered
                        ? 'no rate, left out'
                        : 'not entered, left out'}
                  </span>
                </li>
              ))}
            </ol>
            <p className="drill-usage-sum">
              {counted.length === 1
                ? 'One month entered'
                : `${formatMoney(counted.reduce((s, m) => s + (m.amount ?? 0), 0), currency)} ÷ ${counted.length} months`}{' '}
              = <strong>{formatMoney(entry.usage_monthly_reported, currency)}</strong> a month × 12 ={' '}
              <strong>{formatMoney(entry.usage_annual_reported, currency)}</strong> a year
            </p>
            {counted.length < entry.usage_window.length ? (
              <p className="drill-sub" style={{ margin: 0 }}>
                A month with no bill entered is left out of the average, not counted as zero. If a month
                really cost nothing, enter it as 0 on the{' '}
                <Link to={`/products/${entry.product.id}`}>product's page</Link> and the average will
                include it.
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
