import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoney } from '../../shared/money';
import { formatDate } from '../../shared/dates';

/**
 * Hand-rolled SVG charts.
 *
 * Written by hand rather than with a charting library so the mark specs can be
 * met exactly: 4px rounded data-ends anchored to the baseline (rounded on the
 * growth end only -- rounding the baseline end makes a bar look like it floats),
 * a 2px gap between adjacent fills, recessive grid and axis lines, selective
 * direct labels rather than a number on every mark, and a hover layer on every
 * plot.
 *
 * Every chart here shows a single measure, so each uses one series colour and
 * needs no legend -- the title names what is being shown.
 */

// ------------------------------------------------------------ sizing

/**
 * Measure the container and render the SVG at its true pixel width.
 *
 * The alternative -- a fixed viewBox scaled with preserveAspectRatio="none" --
 * stretches the text along with the geometry, so labels come out horizontally
 * squashed or smeared at any width but the design width. Measuring means one
 * SVG unit is always one CSS pixel, and type renders at the size it was set.
 */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

// ---------------------------------------------------------------- tooltip

interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}

export function useTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);

  const show = useCallback((event: { clientX: number; clientY: number }, content: ReactNode) => {
    setTip({ x: event.clientX, y: event.clientY, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  const node = tip ? (
    <div
      className="tooltip"
      role="tooltip"
      style={{
        // Nudged away from the cursor, and flipped near the right edge so the
        // tooltip never falls off screen.
        left: Math.min(tip.x + 14, window.innerWidth - 270),
        top: Math.max(tip.y - 12, 8),
      }}
    >
      {tip.content}
    </div>
  ) : null;

  return { show, hide, node };
}

// ------------------------------------------------------------ mark shapes

/** A bar rounded on its growth end only, so it stays anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number, grow: 'right' | 'up'): string {
  if (w <= 0 || h <= 0) return '';
  if (grow === 'right') {
    const radius = Math.min(r, w, h / 2);
    return `M${x},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h - radius} Q${x + w},${y + h} ${x + w - radius},${y + h} H${x} Z`;
  }
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

/** Axis ticks are landmarks, not values: no decimal places, always compact. */
function axisTick(value: number, currency: string): string {
  if (value === 0) return '0';
  return formatMoney(Math.round(value), currency, { compact: true }).replace(/\.00$/, '');
}

function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

// --------------------------------------------------------- horizontal bars

export interface BarRow {
  label: string;
  value: number;
  sublabel?: string;
}

/**
 * Ranked magnitude across categories. Horizontal because category names are
 * words -- rotating labels under vertical bars to fit is an anti-pattern.
 */
export function BarRows({
  rows,
  currency,
  max: maxOverride,
}: {
  rows: BarRow[];
  currency: string;
  max?: number;
}) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();

  if (rows.length === 0) return <Empty>No spend to show yet.</Empty>;

  const rowHeight = 30;
  const barHeight = 14;
  // The label column shrinks on narrow screens rather than squeezing the bars
  // down to nothing.
  const labelWidth = Math.max(72, Math.min(128, width * 0.34));
  const valueWidth = Math.max(60, Math.min(96, width * 0.22));
  const height = rows.length * rowHeight;
  const max = maxOverride ?? niceCeiling(Math.max(...rows.map((r) => r.value)));
  const charBudget = Math.max(8, Math.floor(labelWidth / 7));

  return (
    <div ref={ref}>
      {width > 0 ? (
      <svg
        className="chart"
        height={height}
        width={width}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Spend by category, highest first. ${rows
          .map((r) => `${r.label}: ${formatMoney(r.value, currency)}`)
          .join('. ')}`}
      >
        {rows.map((row, i) => {
          const y = i * rowHeight;
          const trackWidth = width - labelWidth - valueWidth;
          const barW = max > 0 ? (row.value / max) * trackWidth : 0;
          return (
            <g
              key={row.label}
              className="bar-group"
              onMouseMove={(e) =>
                show(e, (
                  <>
                    <div className="tip-title">{row.label}</div>
                    <div className="tip-row">{formatMoney(row.value, currency)} per year</div>
                    {row.sublabel ? <div className="tip-row">{row.sublabel}</div> : null}
                  </>
                ))
              }
              onMouseLeave={hide}
            >
              {/* Hit target spans the full row, not just the bar. */}
              <rect x={0} y={y} width={width} height={rowHeight} className="mark-hit" />
              <text
                className="series-label"
                x={labelWidth - 10}
                y={y + rowHeight / 2}
                textAnchor="end"
                dominantBaseline="central"
              >
                {row.label.length > charBudget ? `${row.label.slice(0, charBudget - 1)}…` : row.label}
              </text>
              <path
                className="mark"
                d={barPath(labelWidth, y + (rowHeight - barHeight) / 2, Math.max(barW, 2), barHeight, 4, 'right')}
              />
              <text
                className="value-label"
                x={labelWidth + barW + 8}
                y={y + rowHeight / 2}
                dominantBaseline="central"
              >
                {formatMoney(row.value, currency, { compact: true })}
              </text>
            </g>
          );
        })}
      </svg>
      ) : null}
      {node}
    </div>
  );
}

// ------------------------------------------------------------- column chart

export interface ColumnPoint {
  label: string;
  fullLabel: string;
  value: number;
}

/** Change over time for a single measure: what was actually paid, per month. */
export function ColumnChart({ points, currency }: { points: ColumnPoint[]; currency: string }) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();

  if (points.length === 0) return <Empty>No payments recorded yet.</Empty>;

  const height = 180;
  const padLeft = 8;
  const padBottom = 24;
  const padTop = 16;
  const plotHeight = height - padBottom - padTop;
  const max = niceCeiling(Math.max(...points.map((p) => p.value)));
  const slot = (width - padLeft * 2) / points.length;
  // A 2px surface gap between adjacent fills.
  const barWidth = Math.max(6, Math.min(34, slot - 8));

  const ticks = [0, max / 2, max];

  return (
    <div ref={ref}>
      {width > 0 ? (
      <svg
        className="chart"
        height={height}
        width={width}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Amount paid per month. ${points
          .map((p) => `${p.fullLabel}: ${formatMoney(p.value, currency)}`)
          .join('. ')}`}
      >
        {ticks.map((tick) => {
          const y = padTop + plotHeight - (tick / max) * plotHeight;
          return (
            <g key={tick}>
              <line className="gridline" x1={padLeft} x2={width - padLeft} y1={y} y2={y} />
              <text className="axis-label" x={padLeft} y={y - 4}>
                {axisTick(tick, currency)}
              </text>
            </g>
          );
        })}

        {points.map((point, i) => {
          const barHeight = max > 0 ? (point.value / max) * plotHeight : 0;
          const x = padLeft + i * slot + (slot - barWidth) / 2;
          const y = padTop + plotHeight - barHeight;
          return (
            <g
              key={point.label}
              className="bar-group"
              onMouseMove={(e) =>
                show(e, (
                  <>
                    <div className="tip-title">{point.fullLabel}</div>
                    <div className="tip-row">{formatMoney(point.value, currency)} paid</div>
                  </>
                ))
              }
              onMouseLeave={hide}
            >
              <rect x={padLeft + i * slot} y={padTop} width={slot} height={plotHeight} className="mark-hit" />
              <path className="mark" d={barPath(x, y, barWidth, Math.max(barHeight, 2), 4, 'up')} />
            </g>
          );
        })}

        <line
          className="baseline"
          x1={padLeft}
          x2={width - padLeft}
          y1={padTop + plotHeight}
          y2={padTop + plotHeight}
        />

        {/* Labelling every month crowds the axis; show roughly six. */}
        {points.map((point, i) => {
          const every = Math.max(1, Math.ceil(points.length / 6));
          if (i % every !== 0 && i !== points.length - 1) return null;
          return (
            <text
              key={point.label}
              className="axis-label"
              x={padLeft + i * slot + slot / 2}
              y={height - 8}
              textAnchor="middle"
            >
              {point.label}
            </text>
          );
        })}
      </svg>
      ) : null}
      {node}
    </div>
  );
}

// ------------------------------------------------------------- area trend

export interface TrendPoint {
  label: string;
  fullLabel: string;
  value: number;
}

/**
 * Spend over a long window, as an area.
 *
 * A line beats columns here: across two years the question is the shape of the
 * curve, not the value of any one month, and twenty-four separate bars force
 * the eye to compare heights one pair at a time. One measure, so one hue and
 * no legend -- the card title names what is plotted.
 *
 * `splitAt` draws the boundary between the two comparison windows, which is
 * what turns "here is a line" into "this half against that half".
 */
export function AreaTrend({
  points,
  currency,
  splitAt,
}: {
  points: TrendPoint[];
  currency: string;
  splitAt?: number;
}) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) return <Empty>No payments recorded yet.</Empty>;

  const height = 210;
  const padLeft = 8;
  const padRight = 8;
  const padTop = 18;
  const padBottom = 26;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = Math.max(0, width - padLeft - padRight);
  const max = niceCeiling(Math.max(...points.map((p) => p.value), 1));

  const xFor = (i: number) =>
    points.length === 1 ? padLeft + plotWidth / 2 : padLeft + (i / (points.length - 1)) * plotWidth;
  const yFor = (v: number) => padTop + plotHeight - (v / max) * plotHeight;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(p.value)}`).join(' ');
  const area = `${line} L${xFor(points.length - 1)},${padTop + plotHeight} L${xFor(0)},${padTop + plotHeight} Z`;

  const ticks = [0, max / 2, max];

  function pointAt(clientX: number, rect: DOMRect): number {
    const ratio = (clientX - rect.left - padLeft) / Math.max(plotWidth, 1);
    return Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
  }

  return (
    <div ref={ref}>
      {width > 0 ? (
        <svg
          className="chart"
          height={height}
          width={width}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Amount paid per month over ${points.length} months. ${points
            .map((p) => `${p.fullLabel}: ${formatMoney(p.value, currency)}`)
            .join('. ')}`}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const i = pointAt(event.clientX, rect);
            setHover(i);
            const point = points[i];
            if (point) {
              show(event, (
                <>
                  <div className="tip-title">{point.fullLabel}</div>
                  <div className="tip-row">{formatMoney(point.value, currency)} paid</div>
                </>
              ));
            }
          }}
          onMouseLeave={() => {
            setHover(null);
            hide();
          }}
        >
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {ticks.map((tick) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line className="gridline" x1={padLeft} x2={width - padRight} y1={y} y2={y} />
                <text className="axis-label" x={padLeft} y={y - 4}>
                  {axisTick(tick, currency)}
                </text>
              </g>
            );
          })}

          {/* The boundary between the two 12-month windows being compared. */}
          {splitAt !== undefined && splitAt > 0 && splitAt < points.length ? (
            <line
              className="split-rule"
              x1={xFor(splitAt) - (plotWidth / (points.length - 1)) / 2}
              x2={xFor(splitAt) - (plotWidth / (points.length - 1)) / 2}
              y1={padTop - 6}
              y2={padTop + plotHeight}
            />
          ) : null}

          <path d={area} fill="url(#trend-fill)" />
          <path
            d={line}
            fill="none"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          <line
            className="baseline"
            x1={padLeft}
            x2={width - padRight}
            y1={padTop + plotHeight}
            y2={padTop + plotHeight}
          />

          {hover !== null && points[hover] ? (
            <g>
              <line
                className="crosshair"
                x1={xFor(hover)}
                x2={xFor(hover)}
                y1={padTop}
                y2={padTop + plotHeight}
              />
              <circle
                cx={xFor(hover)}
                cy={yFor(points[hover]!.value)}
                r={5}
                fill="var(--series-1)"
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            </g>
          ) : null}

          {points.map((point, i) => {
            const every = Math.max(1, Math.ceil(points.length / 6));
            if (i % every !== 0 && i !== points.length - 1) return null;
            return (
              // fullLabel, not label: across two years the short month name
              // repeats, and a duplicate key silently drops a tick.
              <text
                key={point.fullLabel}
                className="axis-label"
                x={xFor(i)}
                y={height - 8}
                textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
              >
                {point.label}
              </text>
            );
          })}
        </svg>
      ) : null}
      {node}
    </div>
  );
}

// --------------------------------------------------------- renewal timeline

export interface TimelineItem {
  id: string;
  name: string;
  date: string;
  daysUntil: number;
  amount: number | null;
  currency: string;
}

/**
 * Renewals positioned on a real time axis rather than listed.
 *
 * Position is the encoding: clusters of renewals in the same week are the
 * thing worth seeing, and a list hides them completely.
 */
export function RenewalTimeline({ items, horizon = 90 }: { items: TimelineItem[]; horizon?: number }) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();

  if (items.length === 0) return <Empty>Nothing renews in the next {horizon} days.</Empty>;

  const rowHeight = 22;
  const padTop = 28;
  const padBottom = 22;
  const padX = 12;
  const height = padTop + items.length * rowHeight + padBottom;
  const trackWidth = width - padX * 2;
  const xFor = (days: number) => padX + Math.max(0, Math.min(1, days / horizon)) * trackWidth;

  const gridDays = [0, 30, 60, 90].filter((d) => d <= horizon);
  // Labels sit left of the marker once it is far enough right to have room.
  const charBudget = Math.max(10, Math.floor(width / 26));

  return (
    <div ref={ref}>
      {width > 0 ? (
      <svg
        className="chart"
        height={height}
        width={width}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Renewals in the next ${horizon} days. ${items
          .map((i) => `${i.name} in ${i.daysUntil} days`)
          .join('. ')}`}
      >
        {gridDays.map((day) => (
          <g key={day}>
            <line className="gridline" x1={xFor(day)} x2={xFor(day)} y1={padTop - 8} y2={height - padBottom} />
            <text className="axis-label" x={xFor(day)} y={padTop - 14} textAnchor={day === 0 ? 'start' : 'middle'}>
              {day === 0 ? 'today' : `+${day}d`}
            </text>
          </g>
        ))}

        {items.map((item, i) => {
          const y = padTop + i * rowHeight + rowHeight / 2;
          const x = xFor(item.daysUntil);
          const labelLeft = x > trackWidth * 0.62;
          return (
            <g
              key={item.id}
              onMouseMove={(e) =>
                show(e, (
                  <>
                    <div className="tip-title">{item.name}</div>
                    <div className="tip-row">{formatDate(item.date)} · in {item.daysUntil} days</div>
                    {item.amount !== null ? (
                      <div className="tip-row">{formatMoney(item.amount, item.currency)}</div>
                    ) : null}
                  </>
                ))
              }
              onMouseLeave={hide}
            >
              <rect x={0} y={y - rowHeight / 2} width={width} height={rowHeight} className="mark-hit" />
              {/* A leader line from today to the renewal: length reads as "how far off". */}
              <line x1={padX} x2={x} y1={y} y2={y} stroke="var(--grid)" strokeWidth={2} strokeLinecap="round" />
              <circle cx={x} cy={y} r={5} className="mark" stroke="var(--surface-1)" strokeWidth={2} />
              <text
                className="series-label"
                x={labelLeft ? x - 12 : x + 12}
                y={y}
                textAnchor={labelLeft ? 'end' : 'start'}
                dominantBaseline="central"
              >
                {item.name.length > charBudget ? `${item.name.slice(0, charBudget - 1)}…` : item.name}
              </text>
            </g>
          );
        })}
      </svg>
      ) : null}
      {node}
    </div>
  );
}

// ----------------------------------------------------------------- shared

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * Seat usage as a length, not a colour: the bar shows the ratio, and the
 * numbers beside it are always present, so the meaning never depends on hue.
 */
export function SeatMeter({ used, purchased }: { used: number | null; purchased: number | null }) {
  if (purchased === null || purchased === 0) return <span className="cell-sub">—</span>;
  if (used === null) return <span className="cell-sub">{purchased} seats</span>;

  const ratio = Math.min(1, used / purchased);
  return (
    <div className="meter" title={`${used} of ${purchased} seats in use`}>
      <div className="meter-track">
        <div
          className={`meter-fill${ratio < 0.7 ? ' low' : ''}`}
          style={{ width: `${Math.max(ratio * 100, 3)}%` }}
        />
      </div>
      <span className="meter-text">
        {used}/{purchased}
      </span>
    </div>
  );
}
