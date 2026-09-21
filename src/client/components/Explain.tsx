import type { ReactNode } from 'react';

/**
 * What a chart shows, how it was worked out, and why it is worth a glance.
 *
 * Every figure on this page is derived -- converted, averaged, annualised, or
 * restricted to complete months -- and a reader who does not know which cannot
 * challenge a number that looks wrong. This puts the method next to the chart
 * instead of in a document nobody opens.
 *
 * Folded by default: the person who reads this dashboard daily already knows,
 * and should not scroll past the explanation every morning to reach the data.
 */
export default function Explain({
  shows,
  how,
  why,
  label = 'How this is worked out',
}: {
  shows: ReactNode;
  how: ReactNode;
  why?: ReactNode;
  label?: string;
}) {
  return (
    <details className="explain">
      <summary>{label}</summary>
      <dl className="explain-body">
        <div>
          <dt>What it shows. </dt>
          <dd>{shows}</dd>
        </div>
        <div>
          <dt>How it is calculated. </dt>
          <dd>{how}</dd>
        </div>
        {why ? (
          <div>
            <dt>Why it matters. </dt>
            <dd>{why}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}
