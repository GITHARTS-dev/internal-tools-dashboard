import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Banner, EmptyState } from './ui';
import { IconChevronLeft, IconChevronRight, IconClose } from './icons';
import { addMonthsToYearMonth, monthOf } from '../../shared/fx';
import { formatDate } from '../../shared/dates';
import { formatMoney, formatShort } from '../../shared/money';
import { breakdown, itemsBetween, type CurrencyLine } from '../../shared/drilldown';
import type { CeoSummary, InternalProductCost, RunRateItem, SpendItem, YearForecastLine } from '../../shared/types';

/**
 * Drill-downs: any figure on the dashboard opened up into what it is made of.
 *
 * Every panel has the same shape, so it reads without being read: a title, one
 * line saying what period it covers, a row of figures, then tables. No
 * paragraphs. Amounts are in the reporting currency, with the original amount
 * underneath only when it was paid in another one.
 *
 *   Paid      a year, a month or the last twelve: every payment and cloud bill.
 *   Committed this calendar year: paid so far plus the subscription bills still
 *             to come by 31 December. Cloud joins as it is billed.
 *   Run rate  a full year at today's prices, for comparing tools.
 *
 * The open view lives in the URL (`?view=month:2026-09`), so the browser's Back
 * closes it and following a link out of it and coming back reopens it.
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CYCLE_WORD: Record<string, string> = {
  monthly: '/ month',
  quarterly: '/ quarter',
  annual: '/ year',
  one_time: 'once',
  custom: 'custom',
};

function shortMonth(month: string, withYear = true): string {
  const name = MONTH_SHORT[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${name} ${month.slice(0, 4)}` : name;
}

function longMonth(month: string): string {
  return `${MONTH_LONG[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

/** '1 Jan – 8 Oct 2026', dropping the first year when both share it. */
function dateRange(from: string, to: string): string {
  const a = formatDate(from);
  const b = formatDate(to);
  return from.slice(0, 4) === to.slice(0, 4) ? `${a.replace(/ \d{4}$/, '')} – ${b}` : `${a} – ${b}`;
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
  title,
  subtitle,
  onClose,
  nav,
  children,
}: {
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
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={panel} tabIndex={-1}>
        <header className="sheet-head">
          <div style={{ minWidth: 0 }}>
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

// -------------------------------------------------------------- pieces

interface Stat {
  label: string;
  value: string;
  onClick?: () => void;
  tone?: 'critical';
}

/** The row of figures under a panel's title. The first is the total, set larger. */
function Stats({ stats }: { stats: Stat[] }) {
  return (
    <dl className="drill-stats">
      {stats.map((stat, i) => (
        <div key={stat.label} className={`${i === 0 ? 'is-total' : ''}${stat.tone ? ` is-${stat.tone}` : ''}`}>
          <dt>{stat.label}</dt>
          <dd>
            {stat.onClick ? (
              <button type="button" className="link-button strong" onClick={stat.onClick}>
                {stat.value}
                <IconChevronRight size={13} />
              </button>
            ) : (
              stat.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, figure, children }: { title: string; figure?: string; children: ReactNode }) {
  return (
    <section className="drill-section">
      <h3 className="drill-h">
        {title}
        {figure ? <span className="drill-h-figure">{figure}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** An amount in the reporting currency, with what was actually charged under it when that differs. */
function Amount({
  reported,
  amount,
  currency,
  target,
}: {
  reported: number | null;
  amount: number;
  currency: string;
  target: string;
}) {
  if (reported === null) return <Badge tone="warning">No rate</Badge>;
  return (
    <>
      {formatMoney(reported, target)}
      {currency !== target ? <div className="cell-sub">{formatMoney(amount, currency)}</div> : null}
    </>
  );
}

function ToolOrProduct({ label, toolId, productId }: { label: string; toolId: string | null; productId: string | null }) {
  if (toolId) return <Link to={`/tools/${toolId}`}>{label}</Link>;
  if (productId) return <Link to={`/products/${productId}`}>{label}</Link>;
  return <>{label}</>;
}

/** Shown only when something was not in the reporting currency: otherwise it would repeat the total. */
function CurrencyTable({ lines, target, total }: { lines: CurrencyLine[]; target: string; total: number }) {
  if (lines.every((line) => line.currency === target)) return null;
  return (
    <Section title="By currency">
      <div className="table-wrap drill-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col" className="num">Paid</th>
              <th scope="col" className="num">In {target}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.currency}>
                <td className="cell-primary">{line.currency}</td>
                <td className="num">{formatMoney(line.amount, line.currency)}</td>
                <td className="num">
                  {line.unconverted === line.count ? <Badge tone="warning">No rate</Badge> : formatMoney(line.reported, target)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="cell-primary">Total</td>
              <td />
              <td className="num cell-primary">{formatMoney(total, target)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Section>
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
    return <CommittedSheet summary={summary} focus={view.focus} onClose={close} onSwap={swap} />;
  }
  if (view.kind === 'runrate') {
    return <RunRateSheet summary={summary} focus={view.focus} onClose={close} />;
  }

  const arrows = (prev: { label: string; go: () => void; disabled: boolean }, next: typeof prev) => (
    <>
      <button type="button" className="btn subtle sm" onClick={prev.go} disabled={prev.disabled} aria-label={prev.label}>
        <IconChevronLeft size={15} />
      </button>
      <button type="button" className="btn subtle sm" onClick={next.go} disabled={next.disabled} aria-label={next.label}>
        <IconChevronRight size={15} />
      </button>
    </>
  );

  if (view.kind === 'month') {
    const earliest = summary.paid_items.reduce(
      (min, item) => (item.month < min ? item.month : min),
      addMonthsToYearMonth(currentMonth, -23),
    );
    const prev = addMonthsToYearMonth(view.month, -1);
    const next = addMonthsToYearMonth(view.month, 1);
    return (
      <PaidSheet
        summary={summary}
        from={view.month}
        to={view.month}
        title={longMonth(view.month)}
        subtitle={view.month === currentMonth ? `So far, to ${formatDate(summary.today)}` : undefined}
        onClose={close}
        onOpenMonth={null}
        nav={arrows(
          { label: `Previous month, ${longMonth(prev)}`, go: () => swap({ kind: 'month', month: prev }), disabled: prev < earliest },
          { label: `Next month, ${longMonth(next)}`, go: () => swap({ kind: 'month', month: next }), disabled: next > currentMonth },
        )}
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
        title="Last 12 months"
        subtitle={`${shortMonth(from)} – ${shortMonth(to)}`}
        onClose={close}
        onOpenMonth={openMonth}
      />
    );
  }

  const isCurrent = view.year === currentYear;
  const from = `${view.year}-01`;
  return (
    <PaidSheet
      summary={summary}
      from={from}
      to={isCurrent ? currentMonth : `${view.year}-12`}
      title={`Spent in ${view.year}`}
      subtitle={isCurrent ? dateRange(`${view.year}-01-01`, summary.today) : undefined}
      onClose={close}
      onOpenMonth={openMonth}
      nav={arrows(
        {
          label: `Previous year, ${Number(view.year) - 1}`,
          go: () => swap({ kind: 'year', year: String(Number(view.year) - 1) }),
          disabled: !summary.paid_items.some((item) => item.month < from),
        },
        {
          label: `Next year, ${Number(view.year) + 1}`,
          go: () => swap({ kind: 'year', year: String(Number(view.year) + 1) }),
          disabled: view.year >= currentYear,
        },
      )}
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
  subtitle?: string;
  onClose: () => void;
  /** Lets a month heading in a longer period open that month; null in a month view. */
  onOpenMonth: ((month: string) => void) | null;
  nav?: ReactNode;
}) {
  const target = summary.reporting_currency;
  const data = breakdown(itemsBetween(summary.paid_items, from, to), target);

  const stats: Stat[] = [
    { label: 'Total', value: formatMoney(data.total, target) },
    { label: 'Subscriptions', value: formatMoney(data.subscriptions, target) },
  ];
  // Only when bills were entered: a zero here would read as "free", not "none recorded".
  if (data.bill_count > 0) stats.push({ label: 'Cloud', value: formatMoney(data.usage, target) });

  return (
    <Sheet title={title} subtitle={subtitle} onClose={onClose} nav={nav}>
      {data.items.length === 0 ? (
        <EmptyState title="Nothing paid in this period" compact />
      ) : (
        <>
          <Stats stats={stats} />

          {data.unconverted > 0 ? (
            <Banner tone="warning">
              <span>
                <strong>{data.unconverted} left out</strong> — no exchange rate. <Link to="/settings">Fetch rates</Link>
              </span>
            </Banner>
          ) : null}

          <CurrencyTable lines={data.by_currency} target={target} total={data.total} />

          <Section title={`${data.items.length} ${data.items.length === 1 ? 'payment' : 'payments'}`}>
            <ItemTable items={data.items} target={target} single={from === to} onOpenMonth={onOpenMonth} />
          </Section>
        </>
      )}
    </Sheet>
  );
}

function ItemTable({
  items,
  target,
  single,
  onOpenMonth,
}: {
  items: SpendItem[];
  target: string;
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
            <th scope="col">Date</th>
            <th scope="col">What</th>
            <th scope="col" className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {months.map((group) => (
            <MonthRows
              key={group.month}
              group={group}
              target={target}
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
  group,
  target,
  showHeading,
  onOpenMonth,
}: {
  group: { month: string; items: SpendItem[]; total: number };
  target: string;
  showHeading: boolean;
  onOpenMonth: ((month: string) => void) | null;
}) {
  return (
    <>
      {showHeading ? (
        <tr className="drill-month">
          <td colSpan={2}>
            {onOpenMonth ? (
              <button type="button" className="link-button" onClick={() => onOpenMonth(group.month)}>
                {longMonth(group.month)}
                <IconChevronRight size={13} />
              </button>
            ) : (
              longMonth(group.month)
            )}
          </td>
          <td className="num">{formatMoney(group.total, target)}</td>
        </tr>
      ) : null}
      {group.items.map((item) => (
        <tr key={`${item.kind}-${item.id}`}>
          <td className="drill-when">{item.date ? formatDate(item.date) : shortMonth(item.month)}</td>
          <td>
            <div className="cell-primary">
              <span
                className="key-swatch inline"
                style={{ background: item.kind === 'usage' ? 'var(--series-2)' : 'var(--series-1)' }}
                aria-hidden="true"
              />
              <ToolOrProduct label={item.label} toolId={item.tool_id} productId={item.product_id} />
            </div>
            <div className="cell-sub">
              {item.kind === 'usage' ? `Cloud${item.detail ? ` · ${item.detail}` : ''}` : (item.detail ?? 'Subscription')}
            </div>
          </td>
          <td className="num">
            <Amount reported={item.amount_reported} amount={item.amount} currency={item.currency} target={target} />
          </td>
        </tr>
      ))}
    </>
  );
}

// -------------------------------------------------------------- committed

/** The panel title for the whole commitment, or one side of the split. */
const FOCUS_TITLE: Record<Focus, string> = {
  all: 'Committed for',
  subscriptions: 'Subscriptions,',
  products: 'Our products,',
};

function CommittedSheet({
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
  const target = summary.reporting_currency;
  const forecast = summary.year_forecast;
  const year = forecast.year;

  const lines = forecast.lines.filter((line) => inFocus(focus, line.product_id));
  const paid = breakdown(
    itemsBetween(summary.paid_items, `${year}-01`, `${year}-12`).filter((item) => inFocus(focus, item.product_id)),
    target,
  ).total;
  const overdueLines = lines.filter((l) => l.kind === 'overdue');
  const comingLines = lines.filter((l) => l.kind !== 'overdue');
  const sum = (list: YearForecastLine[]) => list.reduce((s, l) => s + (l.amount_reported ?? 0), 0);
  const overdue = sum(overdueLines);
  const coming = sum(comingLines);
  const missingRate = lines.filter((l) => l.amount_reported === null).length;
  const undated = focus === 'products' ? [] : forecast.undated_tools;

  const stats: Stat[] = [
    { label: 'Total', value: formatMoney(paid + overdue + coming, target) },
    { label: 'Paid', value: formatMoney(paid, target), onClick: () => onSwap({ kind: 'year', year }) },
  ];
  if (overdue > 0) stats.push({ label: 'Overdue', value: formatMoney(overdue, target), tone: 'critical' });
  stats.push({ label: 'To come', value: formatMoney(coming, target) });

  const runRate =
    focus === 'subscriptions'
      ? summary.subscriptions.annual_reported
      : focus === 'products'
        ? summary.internal.annual_reported
        : summary.total_annual_reported;

  return (
    <Sheet
      title={`${FOCUS_TITLE[focus]} ${year}`}
      subtitle={`Paid so far + bills due by 31 Dec · cloud is added as it is billed`}
      onClose={onClose}
    >
      <Stats stats={stats} />

      {undated.length > 0 ? (
        <Banner tone="warning">
          <span>
            <strong>No renewal date:</strong>{' '}
            {undated.map((tool, i) => (
              <span key={tool.tool_id}>
                {i > 0 ? ', ' : ''}
                <Link to={`/tools/${tool.tool_id}`}>{tool.label}</Link>
              </span>
            ))}{' '}
            — not included.
          </span>
        </Banner>
      ) : null}

      {missingRate > 0 ? (
        <Banner tone="warning">
          <span>
            <strong>{missingRate} left out</strong> — no exchange rate. <Link to="/settings">Fetch rates</Link>
          </span>
        </Banner>
      ) : null}

      {overdueLines.length > 0 ? (
        <Section title="Overdue" figure={formatMoney(overdue, target)}>
          <BillTable lines={overdueLines} target={target} />
        </Section>
      ) : null}

      {comingLines.length > 0 ? (
        <Section title="To come" figure={formatMoney(coming, target)}>
          <BillTable lines={comingLines} target={target} />
        </Section>
      ) : (
        <EmptyState title="No more bills this year" compact />
      )}

      <button type="button" className="drill-aside" onClick={() => onSwap({ kind: 'runrate', focus })}>
        <span>A full year at today's prices</span>
        <strong>{formatMoney(runRate, target)}</strong>
        <IconChevronRight size={14} />
      </button>
    </Sheet>
  );
}

const BILL_KIND: Record<YearForecastLine['kind'], string> = {
  overdue: 'Overdue',
  scheduled: 'Scheduled',
  renewal: 'Next bill',
};

function BillTable({ lines, target }: { lines: YearForecastLine[]; target: string }) {
  return (
    <div className="table-wrap drill-table">
      <table>
        <thead>
          <tr>
            <th scope="col">Due</th>
            <th scope="col">Tool</th>
            <th scope="col" className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={`${line.kind}-${line.id}`}>
              <td className="drill-when">{formatDate(line.date)}</td>
              <td>
                <div className="cell-primary">
                  <ToolOrProduct label={line.label} toolId={line.tool_id} productId={line.product_id} />
                </div>
                <div className="cell-sub">
                  {/* Under "Overdue" the kind would only repeat the heading. */}
                  {[line.kind === 'overdue' ? null : BILL_KIND[line.kind], line.detail].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td className="num">
                <Amount reported={line.amount_reported} amount={line.amount} currency={line.currency} target={target} />
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
  const target = summary.reporting_currency;
  const bought = summary.run_rate_items.filter((item) => item.product_id === null);

  useEffect(() => {
    if (focus === 'all') return;
    document.getElementById(`runrate-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);

  return (
    <Sheet title="A full year at today's prices" subtitle="For comparing tools — not this year's spend" onClose={onClose}>
      <Stats
        stats={[
          { label: 'Per year', value: formatMoney(summary.total_annual_reported, target) },
          { label: 'Per month', value: formatMoney(summary.total_monthly_reported, target) },
        ]}
      />

      <div id="runrate-subscriptions">
        <Section title="Subscriptions" figure={formatMoney(summary.subscriptions.annual_reported, target)}>
          <RunRateTable items={bought} target={target} />
        </Section>
      </div>

      <div id="runrate-products">
        <Section title="Our products" figure={formatMoney(summary.internal.annual_reported, target)}>
          {summary.products.length === 0 ? (
            <EmptyState title="No internal products yet" compact />
          ) : (
            <ProductRunRateTable summary={summary} />
          )}
        </Section>
      </div>
    </Sheet>
  );
}

function RunRateTable({ items, target }: { items: RunRateItem[]; target: string }) {
  if (items.length === 0) return <EmptyState title="None" compact />;
  return (
    <div className="table-wrap drill-table">
      <table>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col" className="num">Price</th>
            <th scope="col" className="num">Per year</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.tool_id}>
              <td className="cell-primary">
                <Link to={`/tools/${item.tool_id}`}>{item.label}</Link>
              </td>
              <td className="num">
                {formatMoney(item.cost_amount, item.currency)}
                <span className="cell-sub"> {CYCLE_WORD[item.billing_cycle] ?? item.billing_cycle}</span>
              </td>
              <td className="num">
                <Amount reported={item.annual_reported} amount={item.annual} currency={item.currency} target={target} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One row per subscription a product runs on, and one for its cloud at the recent average. */
function ProductRunRateTable({ summary }: { summary: CeoSummary }) {
  const target = summary.reporting_currency;
  return (
    <div className="table-wrap drill-table">
      <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Cost</th>
            <th scope="col" className="num">Per year</th>
          </tr>
        </thead>
        <tbody>
          {summary.products.map((entry) => (
            <ProductRows
              key={entry.product.id}
              entry={entry}
              items={summary.run_rate_items.filter((item) => item.product_id === entry.product.id)}
              target={target}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductRows({ entry, items, target }: { entry: InternalProductCost; items: RunRateItem[]; target: string }) {
  const counted = entry.usage_window.filter((m) => m.amount !== null);
  const rows = items.length + 1;
  return (
    <>
      {items.map((item, i) => (
        <tr key={item.tool_id}>
          {i === 0 ? (
            <td rowSpan={rows} className="cell-primary drill-product-cell">
              <Link to={`/products/${entry.product.id}`}>{entry.product.name}</Link>
            </td>
          ) : null}
          <td>
            <Link to={`/tools/${item.tool_id}`}>{item.label}</Link>
          </td>
          <td className="num">
            <Amount reported={item.annual_reported} amount={item.annual} currency={item.currency} target={target} />
          </td>
        </tr>
      ))}
      <tr>
        {items.length === 0 ? (
          <td className="cell-primary drill-product-cell">
            <Link to={`/products/${entry.product.id}`}>{entry.product.name}</Link>
          </td>
        ) : null}
        <td>
          Cloud, average × 12
          <div className="cell-sub">
            {entry.usage_window
              .map((m) => `${shortMonth(m.month, false)} ${m.amount === null ? '—' : formatShort(m.amount, target)}`)
              .join(' · ')}
            {counted.length > 0 && counted.length < entry.usage_window.length ? ' (— not counted)' : ''}
          </div>
        </td>
        <td className="num">
          {entry.usage_annual_reported === null ? (
            <span className="cell-sub">no bills</span>
          ) : (
            formatMoney(entry.usage_annual_reported, target)
          )}
        </td>
      </tr>
    </>
  );
}
