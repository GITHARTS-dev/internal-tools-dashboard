import { formatDate, relativeDays } from '../../shared/dates';
import { alertsByRule } from '../../shared/alerts';
import type { Alert } from '../../shared/types';

const RULE_HEADINGS: Record<string, string> = {
  payment_overdue: 'Overdue payments',
  payment_due_soon: 'Payments due soon',
  notice_deadline: 'Cancellation deadlines',
  renewal_upcoming: 'Upcoming renewals',
  seats_underused: 'Unused seats',
  missing_data: 'Records needing details',
};

/** Order the sections by how much they cost to ignore. */
const RULE_ORDER = [
  'payment_overdue',
  'notice_deadline',
  'payment_due_soon',
  'renewal_upcoming',
  'missing_data',
  'seats_underused',
] as const;

export function summaryLine(alerts: Alert[]): string {
  const critical = alerts.filter((a) => a.severity === 'critical').length;
  const total = alerts.length;
  if (total === 0) return 'Nothing needs attention.';
  const item = total === 1 ? 'item needs' : 'items need';
  return critical > 0
    ? `${total} ${item} attention, ${critical} urgently.`
    : `${total} ${item} attention.`;
}

function alertLine(alert: Alert): string {
  const when =
    alert.days_until === null
      ? ''
      : ` — ${relativeDays(alert.days_until)}${alert.date ? ` (${formatDate(alert.date)})` : ''}`;
  const owner = alert.owner_name ? ` [owner: ${alert.owner_name}]` : '';
  return `• ${alert.title}${when}${owner}`;
}

/** Plain text, grouped by rule. Used by email and as the console output. */
export function formatAlertsText(alerts: Alert[]): string {
  const grouped = alertsByRule(alerts);
  const sections: string[] = [];

  for (const rule of RULE_ORDER) {
    const group = grouped[rule];
    if (!group || group.length === 0) continue;
    sections.push(`${RULE_HEADINGS[rule]} (${group.length})\n${group.map(alertLine).join('\n')}`);
  }

  return sections.join('\n\n');
}

export interface GroupedSection {
  heading: string;
  alerts: Alert[];
}

export function groupedSections(alerts: Alert[]): GroupedSection[] {
  const grouped = alertsByRule(alerts);
  const out: GroupedSection[] = [];
  for (const rule of RULE_ORDER) {
    const group = grouped[rule];
    if (group && group.length > 0) out.push({ heading: RULE_HEADINGS[rule] ?? rule, alerts: group });
  }
  return out;
}
