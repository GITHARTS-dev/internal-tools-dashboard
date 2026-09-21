import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { currencySymbol, decimalPlaces, formatMoney } from '../../shared/money';
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
 * Each chart is chosen for the question it answers, not for looking like a
 * chart:
 *
 *   StackedColumns   which kind of spend moved, month by month
 *   CumulativeCompare are we spending more than at this point last year
 *   RenewalTimeline  what is coming, and when the cancellation window closes
 *   BarRows          where the money is concentrated, and how much of the whole
 *   Sparkline        the shape of a single measure, small enough to sit in a headline
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

/**
 * A column of amounts has to share one format. Compacting only the large ones
 * puts ₹1.7L beside ₹96,000.00, which cannot be compared by eye; so once
 * any row needs compacting, every row is compacted.
 */
function columnFormatter(values: number[], currency: string): (value: number) => string {
  const places = decimalPlaces(currency);
  const compactAll = Math.max(0, ...values) >= 100_000 * 10 ** places;
  if (!compactAll) return (value) => formatMoney(value, currency);
  const locale = currency.toUpperCase() === 'INR' ? 'en-IN' : 'en-US';
  const format = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  return (value) => `${currencySymbol(currency)}${format.format(value / 10 ** places)}`;
}

/** Trim a label to a character budget, ending on an ellipsis rather than a cut word. */
function clip(text: string, budget: number): string {
  return text.length > budget ? `${text.slice(0, Math.max(1, budget - 1))}…` : text;
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
 *
 * With `total` each row also says what share of the whole it is. A ranked list
 * of amounts leaves the reader to work out concentration in their head; a
 * percentage beside each bar does it for them, and it is the number that
 * decides whether a single tool is worth negotiating.
 */
export function BarRows({
  rows,
  currency,
  total,
  max: maxOverride,
  noun = 'Spend',
}: {
  rows: BarRow[];
  currency: string;
  /** The whole these rows are part of, for the share column. */
  total?: number;
  max?: number;
  noun?: string;
}) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();

  if (rows.length === 0) return <Empty>No spend to show yet.</Empty>;

  const rowHeight = 32;
  const barHeight = 12;
  // The label column shrinks on narrow screens rather than squeezing the bars
  // down to nothing.
  const labelWidth = Math.max(78, Math.min(150, width * 0.34));
  const valueWidth = total ? Math.max(112, Math.min(140, width * 0.3)) : Math.max(60, Math.min(96, width * 0.22));
  const height = rows.length * rowHeight;
  const max = maxOverride ?? niceCeiling(Math.max(...rows.map((r) => r.value)));
  const charBudget = Math.max(8, Math.floor(labelWidth / 7));
  const formatValue = columnFormatter(rows.map((r) => r.value), currency);

  return (
    <div ref={ref}>
      {width > 0 ? (
        <svg
          className="chart"
          height={height}
          width={width}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${noun}, highest first. ${rows
            .map((r) => `${r.label}: ${formatMoney(r.value, currency)}`)
            .join('. ')}`}
        >
          {rows.map((row, i) => {
            const y = i * rowHeight;
            const trackWidth = width - labelWidth - valueWidth;
            const barW = max > 0 ? (row.value / max) * trackWidth : 0;
            const share = total && total > 0 ? Math.round((row.value / total) * 100) : null;
            return (
              <g
                key={row.label}
                className="bar-group"
                onMouseMove={(e) =>
                  show(e, (
                    <>
                      <div className="tip-title">{row.label}</div>
                      <div className="tip-row">{formatMoney(row.value, currency)} per year</div>
                      {share !== null ? <div className="tip-row">{share}% of the total</div> : null}
                      {row.sublabel ? <div className="tip-row">{row.sublabel}</div> : null}
                    </>
                  ))
                }
                onMouseLeave={hide}
              >
                {/* Hit target spans the full row, not just the bar. */}
                <rect x={0} y={y} width={width} height={rowHeight} className="mark-hit" />
                {/* The track shows how much of the maximum this is, and how much is left. */}
                <rect
                  x={labelWidth}
                  y={y + (rowHeight - barHeight) / 2}
                  width={trackWidth}
                  height={barHeight}
                  rx={3}
                  className="bar-track"
                />
                <text
                  className="series-label"
                  x={labelWidth - 10}
                  y={y + rowHeight / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                >
                  {clip(row.label, charBudget)}
                </text>
                <path
                  className="mark"
                  d={barPath(labelWidth, y + (rowHeight - barHeight) / 2, Math.max(barW, 3), barHeight, 3, 'right')}
                />
                <text
                  className="value-label"
                  x={labelWidth + trackWidth + 10}
                  y={y + rowHeight / 2}
                  dominantBaseline="central"
                >
                  {formatValue(row.value)}
                  {share !== null ? (
                    <tspan className="share-label" dx={7}>
                      {share}%
                    </tspan>
                  ) : null}
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

// ---------------------------------------------------------- stacked columns

export interface StackSeries {
  key: string;
  name: string;
  /** A CSS colour, normally a --series-N token. */
  colour: string;
}

export interface StackPoint {
  label: string;
  fullLabel: string;
  values: number[];
}

/**
 * Spend by month, stacked by kind.
 *
 * Stacking is the honest form when the question is "what is the total, and
 * which part of it moved". The total is what the eye reads from the top of each
 * column; each segment's own size is what the tooltip and the end labels state.
 * Series are labelled directly at the last column as well as in the legend, so
 * identity never rests on colour alone.
 */
export function StackedColumns({
  points,
  series,
  currency,
}: {
  points: StackPoint[];
  series: StackSeries[];
  currency: string;
}) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) return <Empty>No payments recorded yet.</Empty>;

  const height = 232;
  const padLeft = 8;
  const padRight = 84;
  const padTop = 16;
  const padBottom = 26;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = Math.max(0, width - padLeft - padRight);
  const totals = points.map((p) => p.values.reduce((sum, v) => sum + v, 0));
  const max = niceCeiling(Math.max(...totals, 1));
  const slot = plotWidth / points.length;
  const barWidth = Math.max(8, Math.min(38, slot - 10));
  const ticks = [0, max / 2, max];
  const yFor = (v: number) => padTop + plotHeight - (v / max) * plotHeight;

  const last = points[points.length - 1]!;

  return (
    <div ref={ref}>
      {width > 0 ? (
        <svg
          className="chart"
          height={height}
          width={width}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Amount paid per month, by kind. ${points
            .map(
              (p) =>
                `${p.fullLabel}: ${series.map((s, i) => `${s.name} ${formatMoney(p.values[i] ?? 0, currency)}`).join(', ')}`,
            )
            .join('. ')}`}
        >
          {ticks.map((tick) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line className="gridline" x1={padLeft} x2={padLeft + plotWidth} y1={y} y2={y} />
                <text className="axis-label" x={padLeft} y={y - 5}>
                  {axisTick(tick, currency)}
                </text>
              </g>
            );
          })}

          {points.map((point, i) => {
            const x = padLeft + i * slot + (slot - barWidth) / 2;
            const dimmed = hover !== null && hover !== i;
            let stacked = 0;
            const lastFilled = point.values.reduce((acc, v, idx) => (v > 0 ? idx : acc), -1);

            return (
              <g
                key={point.fullLabel}
                opacity={dimmed ? 0.45 : 1}
                style={{ transition: 'opacity 0.12s' }}
                onMouseMove={(e) => {
                  setHover(i);
                  show(e, (
                    <>
                      <div className="tip-title">{point.fullLabel}</div>
                      {series.map((s, si) => (
                        <div className="tip-row" key={s.key}>
                          <span className="tip-swatch" style={{ background: s.colour }} />
                          {s.name} {formatMoney(point.values[si] ?? 0, currency)}
                        </div>
                      ))}
                      <div className="tip-row tip-total">Total {formatMoney(totals[i] ?? 0, currency)}</div>
                    </>
                  ));
                }}
                onMouseLeave={() => {
                  setHover(null);
                  hide();
                }}
              >
                <rect x={padLeft + i * slot} y={padTop} width={slot} height={plotHeight} className="mark-hit" />
                {series.map((s, si) => {
                  const value = point.values[si] ?? 0;
                  if (value <= 0) return null;
                  const h = Math.max((value / max) * plotHeight, 2);
                  const y = yFor(stacked + value);
                  stacked += value;
                  // Only the top segment is rounded: it is the growth end, and a
                  // rounded join between two segments reads as a gap.
                  const isTop = si === lastFilled;
                  return isTop ? (
                    <path key={s.key} d={barPath(x, y, barWidth, h, 3, 'up')} fill={s.colour} stroke="var(--chart-gap)" strokeWidth={1.5} />
                  ) : (
                    <rect key={s.key} x={x} y={y} width={barWidth} height={h} fill={s.colour} stroke="var(--chart-gap)" strokeWidth={1.5} />
                  );
                })}
              </g>
            );
          })}

          <line className="baseline" x1={padLeft} x2={padLeft + plotWidth} y1={padTop + plotHeight} y2={padTop + plotHeight} />

          {points.map((point, i) => {
            // Labelling every month crowds the axis; roughly every other one is plenty.
            const every = points.length > 8 ? 2 : 1;
            if (i % every !== 0 && i !== points.length - 1) return null;
            return (
              <text
                key={`x-${point.fullLabel}`}
                className="axis-label"
                x={padLeft + i * slot + slot / 2}
                y={height - 8}
                textAnchor="middle"
              >
                {point.label}
              </text>
            );
          })}

          {/* Direct labels at the last column, where there is room to the right. */}
          {(() => {
            let acc = 0;
            return series.map((s, si) => {
              const value = last.values[si] ?? 0;
              const mid = acc + value / 2;
              acc += value;
              if (value <= 0 || (value / max) * plotHeight < 13) return null;
              return (
                <text
                  key={`end-${s.key}`}
                  className="end-label"
                  x={padLeft + plotWidth + 8}
                  y={yFor(mid)}
                  dominantBaseline="central"
                >
                  {s.name}
                </text>
              );
            });
          })()}
        </svg>
      ) : null}
      <div className="legend">
        {series.map((s) => (
          <span className="legend-item" key={s.key}>
            <span className="legend-swatch" style={{ background: s.colour }} />
            {s.name}
          </span>
        ))}
      </div>
      {node}
    </div>
  );
}

// ------------------------------------------------------ cumulative compare

export interface CumulativeInput {
  /** Twelve values, January first. Null where the month has not happened yet. */
  current: Array<number | null>;
  previous: Array<number | null>;
  months: string[];
  currentLabel: string;
  previousLabel: string;
}

/**
 * This year against last, as running totals.
 *
 * A single month is noisy -- an annual invoice lands in one lump -- so month
 * against month misleads. Running totals smooth that out and put the question
 * in its natural form: at this point in the year, are we ahead of or behind the
 * same point last year? The gap at the latest month is labelled, because that
 * one number is the answer.
 *
 * Last year is drawn in neutral grey and this year in the accent: one series is
 * the point, the other is its context.
 */
export function CumulativeCompare({
  data,
  currency,
}: {
  data: CumulativeInput;
  currency: string;
}) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);
  const { current, previous, months, currentLabel, previousLabel } = data;

  const anyData = [...current, ...previous].some((v) => v !== null && v > 0);
  if (!anyData) return <Empty>Not enough history to compare years yet.</Empty>;

  const height = 232;
  const padLeft = 8;
  const padRight = 64;
  const padTop = 22;
  const padBottom = 26;
  const plotHeight = height - padTop - padBottom;
  const plotWidth = Math.max(0, width - padLeft - padRight);
  const count = months.length;
  const max = niceCeiling(Math.max(...[...current, ...previous].map((v) => v ?? 0), 1));
  const xFor = (i: number) => padLeft + (count === 1 ? plotWidth / 2 : (i / (count - 1)) * plotWidth);
  const yFor = (v: number) => padTop + plotHeight - (v / max) * plotHeight;
  const ticks = [0, max / 2, max];

  const path = (values: Array<number | null>) => {
    let d = '';
    values.forEach((v, i) => {
      if (v === null) return;
      d += `${d === '' ? 'M' : 'L'}${xFor(i)},${yFor(v)} `;
    });
    return d.trim();
  };

  let lastIdx = -1;
  current.forEach((v, i) => {
    if (v !== null) lastIdx = i;
  });
  const cur = lastIdx >= 0 ? (current[lastIdx] ?? 0) : 0;
  const prev = lastIdx >= 0 ? (previous[lastIdx] ?? 0) : 0;
  const gap = cur - prev;

  function indexAt(clientX: number, rect: DOMRect): number {
    const ratio = (clientX - rect.left - padLeft) / Math.max(plotWidth, 1);
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
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
          aria-label={`Running total spend this year against last year. ${months
            .map(
              (m, i) =>
                `${m}: ${currentLabel} ${current[i] === null ? 'not yet' : formatMoney(current[i] ?? 0, currency)}, ${previousLabel} ${formatMoney(previous[i] ?? 0, currency)}`,
            )
            .join('. ')}`}
          onMouseMove={(event) => {
            const i = indexAt(event.clientX, event.currentTarget.getBoundingClientRect());
            setHover(i);
            const c = current[i];
            const p = previous[i];
            show(event, (
              <>
                <div className="tip-title">{months[i]}</div>
                <div className="tip-row">
                  <span className="tip-swatch" style={{ background: 'var(--series-1)' }} />
                  {currentLabel} {c === null ? 'not yet' : formatMoney(c ?? 0, currency)}
                </div>
                <div className="tip-row">
                  <span className="tip-swatch" style={{ background: 'var(--compare-prev)' }} />
                  {previousLabel} {formatMoney(p ?? 0, currency)}
                </div>
                {c != null && p != null ? (
                  <div className="tip-row tip-total">
                    {c - p >= 0 ? 'Up by ' : 'Down by '}
                    {formatMoney(Math.abs(c - p), currency)}
                  </div>
                ) : null}
              </>
            ));
          }}
          onMouseLeave={() => {
            setHover(null);
            hide();
          }}
        >
          {ticks.map((tick) => {
            const y = yFor(tick);
            return (
              <g key={tick}>
                <line className="gridline" x1={padLeft} x2={padLeft + plotWidth} y1={y} y2={y} />
                <text className="axis-label" x={padLeft} y={y - 5}>
                  {axisTick(tick, currency)}
                </text>
              </g>
            );
          })}

          <line className="baseline" x1={padLeft} x2={padLeft + plotWidth} y1={padTop + plotHeight} y2={padTop + plotHeight} />

          {/* Last year: context. Neutral, thinner, behind. */}
          <path d={path(previous)} fill="none" stroke="var(--compare-prev)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {/* This year: the point of the chart. */}
          <path d={path(current)} fill="none" stroke="var(--series-1)" strokeWidth={2.75} strokeLinejoin="round" strokeLinecap="round" />

          {current.map((v, i) =>
            v === null ? null : (
              <circle key={`c-${i}`} cx={xFor(i)} cy={yFor(v)} r={i === lastIdx ? 5 : 3} fill="var(--series-1)" stroke="var(--chart-gap)" strokeWidth={2} />
            ),
          )}

          {/* The gap at the latest month, drawn and named. */}
          {lastIdx >= 0 && prev > 0 ? (
            <g>
              <line
                x1={xFor(lastIdx) + 11}
                x2={xFor(lastIdx) + 11}
                y1={yFor(cur)}
                y2={yFor(prev)}
                stroke="var(--text-muted)"
                strokeWidth={1.25}
              />
              <line x1={xFor(lastIdx) + 8} x2={xFor(lastIdx) + 14} y1={yFor(cur)} y2={yFor(cur)} stroke="var(--text-muted)" strokeWidth={1.25} />
              <line x1={xFor(lastIdx) + 8} x2={xFor(lastIdx) + 14} y1={yFor(prev)} y2={yFor(prev)} stroke="var(--text-muted)" strokeWidth={1.25} />
              <text
                className="gap-label"
                x={xFor(lastIdx) + 19}
                y={(yFor(cur) + yFor(prev)) / 2}
                dominantBaseline="central"
              >
                {gap >= 0 ? '+' : '−'}
                {formatMoney(Math.abs(gap), currency, { compact: true })}
              </text>
            </g>
          ) : null}

          {hover !== null ? (
            <line className="crosshair" x1={xFor(hover)} x2={xFor(hover)} y1={padTop} y2={padTop + plotHeight} />
          ) : null}

          {months.map((m, i) =>
            i % 2 === 0 ? (
              <text key={m} className="axis-label" x={xFor(i)} y={height - 8} textAnchor={i === 0 ? 'start' : 'middle'}>
                {m}
              </text>
            ) : null,
          )}
        </svg>
      ) : null}
      <div className="legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--series-1)' }} />
          {currentLabel}
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: 'var(--compare-prev)' }} />
          {previousLabel}
        </span>
      </div>
      {node}
    </div>
  );
}

// --------------------------------------------------------------- sparkline

/**
 * The shape of one measure, small enough to sit in a headline.
 *
 * No axes and no gridlines: at this size they would be noise. It exists to give
 * a big number a direction, and hovering a point says exactly what it was.
 */
export function Sparkline({
  values,
  labels,
  currency,
  height = 52,
}: {
  values: number[];
  labels: string[];
  currency: string;
  height?: number;
}) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);

  if (values.length < 2) return null;

  const pad = 5;
  const max = Math.max(...values, 1);
  const min = 0;
  const xFor = (i: number) => pad + (i / (values.length - 1)) * Math.max(width - pad * 2, 1);
  const yFor = (v: number) => pad + (height - pad * 2) - ((v - min) / (max - min || 1)) * (height - pad * 2);

  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(v)}`).join(' ');
  const area = `${line} L${xFor(values.length - 1)},${height - pad} L${xFor(0)},${height - pad} Z`;
  const shown = hover ?? values.length - 1;

  return (
    <div ref={ref} className="sparkline">
      {width > 0 ? (
        <svg
          className="chart"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Paid per month: ${labels.map((l, i) => `${l} ${formatMoney(values[i] ?? 0, currency)}`).join(', ')}`}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - rect.left - pad) / Math.max(width - pad * 2, 1);
            const i = Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))));
            setHover(i);
            show(event, (
              <>
                <div className="tip-title">{labels[i]}</div>
                <div className="tip-row">{formatMoney(values[i] ?? 0, currency)} paid</div>
              </>
            ));
          }}
          onMouseLeave={() => {
            setHover(null);
            hide();
          }}
        >
          <defs>
            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#spark-fill)" />
          <path d={line} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={xFor(shown)} cy={yFor(values[shown] ?? 0)} r={4} fill="var(--series-1)" stroke="var(--chart-gap)" strokeWidth={2} />
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
  /** Days until the last day to cancel. Negative once that window has closed. */
  noticeDaysUntil?: number | null;
  noticeDate?: string | null;
}

/**
 * Renewals positioned on a real time axis rather than listed.
 *
 * Position is the encoding: clusters of renewals in the same week are the thing
 * worth seeing, and a list hides them completely.
 *
 * It also draws the thing this app exists to catch. For a tool that auto-renews
 * and needs notice, the stretch between its last day to cancel and the renewal
 * is time you are already committed for. It is drawn in the warning colour with
 * a hollow ring at the deadline; if the deadline has already passed, the whole
 * lead-in is committed and there is no ring, because there is nothing left to
 * decide.
 */
export function RenewalTimeline({ items, horizon = 90 }: { items: TimelineItem[]; horizon?: number }) {
  const { show, hide, node } = useTooltip();
  const [ref, width] = useMeasuredWidth();

  if (items.length === 0) return <Empty>Nothing renews in the next {horizon} days.</Empty>;

  const rowHeight = 25;
  const padTop = 28;
  const padBottom = 8;
  const padX = 12;
  const height = padTop + items.length * rowHeight + padBottom;
  const trackWidth = width - padX * 2;
  const xFor = (days: number) => padX + Math.max(0, Math.min(1, days / horizon)) * trackWidth;

  const gridDays = [0, 30, 60, 90].filter((d) => d <= horizon);
  const charBudget = Math.max(10, Math.floor(width / 26));
  const hasWindow = items.some((i) => i.noticeDaysUntil !== null && i.noticeDaysUntil !== undefined);

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
            .map((i) => {
              const window =
                i.noticeDaysUntil === null || i.noticeDaysUntil === undefined
                  ? ''
                  : i.noticeDaysUntil < 0
                    ? `, cancellation window closed ${-i.noticeDaysUntil} days ago`
                    : `, last day to cancel in ${i.noticeDaysUntil} days`;
              return `${i.name} renews in ${i.daysUntil} days${window}`;
            })
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
            const labelLeft = x > padX + trackWidth * 0.62;

            const notice = item.noticeDaysUntil;
            const hasNotice = notice !== null && notice !== undefined;
            const closed = hasNotice && notice < 0;
            const noticeX = hasNotice ? xFor(Math.max(0, notice)) : null;
            // Where the committed stretch begins: today if the window has closed,
            // otherwise the deadline itself.
            const lockedFrom = hasNotice ? (closed ? padX : (noticeX ?? padX)) : null;

            return (
              <g
                key={item.id}
                onMouseMove={(e) =>
                  show(e, (
                    <>
                      <div className="tip-title">{item.name}</div>
                      <div className="tip-row">
                        Renews {formatDate(item.date)} · in {item.daysUntil} days
                      </div>
                      {item.amount !== null ? <div className="tip-row">{formatMoney(item.amount, item.currency)}</div> : null}
                      {hasNotice ? (
                        <div className="tip-row tip-total">
                          {closed
                            ? `Cancellation window closed ${-notice!} days ago`
                            : `Last day to cancel ${item.noticeDate ? formatDate(item.noticeDate) : ''} · in ${notice} days`}
                        </div>
                      ) : null}
                    </>
                  ))
                }
                onMouseLeave={hide}
              >
                <rect x={0} y={y - rowHeight / 2} width={width} height={rowHeight} className="mark-hit" />

                {/* Time until the renewal. */}
                <line x1={padX} x2={x} y1={y} y2={y} stroke="var(--rule-strong)" strokeWidth={2} strokeLinecap="round" />

                {/* Time you are already committed for: past the cancel deadline. */}
                {lockedFrom !== null ? (
                  <line
                    x1={lockedFrom}
                    x2={x}
                    y1={y}
                    y2={y}
                    stroke="var(--status-warning)"
                    strokeWidth={3.5}
                    strokeLinecap="round"
                  />
                ) : null}

                {/* The last day to cancel, while there is still a day to cancel on. */}
                {hasNotice && !closed && noticeX !== null ? (
                  <circle cx={noticeX} cy={y} r={4.5} fill="var(--chart-gap)" stroke="var(--status-warning)" strokeWidth={2} />
                ) : null}

                <circle cx={x} cy={y} r={5} className="mark" stroke="var(--chart-gap)" strokeWidth={2} />
                <text
                  className="series-label"
                  x={labelLeft ? x - 12 : x + 12}
                  y={y}
                  textAnchor={labelLeft ? 'end' : 'start'}
                  dominantBaseline="central"
                >
                  {clip(item.name, charBudget)}
                </text>
              </g>
            );
          })}
        </svg>
      ) : null}
      {hasWindow ? (
        <div className="legend">
          <span className="legend-item">
            <svg width="14" height="12" aria-hidden="true">
              <circle cx="7" cy="6" r="4.5" className="mark" stroke="var(--chart-gap)" strokeWidth="2" />
            </svg>
            Renews
          </span>
          <span className="legend-item">
            <svg width="14" height="12" aria-hidden="true">
              <circle cx="7" cy="6" r="4" fill="var(--chart-gap)" stroke="var(--status-warning)" strokeWidth="2" />
            </svg>
            Last day to cancel
          </span>
          <span className="legend-item">
            <svg width="20" height="12" aria-hidden="true">
              <line x1="2" x2="18" y1="6" y2="6" stroke="var(--status-warning)" strokeWidth="3.5" strokeLinecap="round" />
            </svg>
            Already committed
          </span>
        </div>
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
        <div className={`meter-fill${ratio < 0.7 ? ' low' : ''}`} style={{ width: `${Math.max(ratio * 100, 3)}%` }} />
      </div>
      <span className="meter-text">
        {used}/{purchased}
      </span>
    </div>
  );
}
