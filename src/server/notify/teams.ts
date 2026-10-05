import type { Channel, NotificationPayload } from './types';
import { SUBJECT_PREFIX, groupedSections } from './format';
import { formatDate, isoWeekday, todayInTimezone } from '../../shared/dates';
import type { Alert, IsoDate, Severity } from '../../shared/types';

/**
 * Microsoft Teams, via an incoming webhook URL.
 *
 * The payload is an Adaptive Card wrapped in a `message` attachment, which is
 * the shape both a Power Automate "Teams webhook request" trigger and a legacy
 * Office 365 connector accept. Microsoft has been retiring the old connectors,
 * so a Workflows URL is the one to create today -- either works here.
 *
 * Where the card lands is the workflow's business, not this file's: a personal
 * chat per person, or one group chat posted by a bot account, are both just a
 * different workflow on the other end of the same URL. Changing who is told
 * needs no deploy.
 *
 * Needs nothing but a URL pasted into Settings: no app registration, no admin
 * consent, no credentials. That is why it is the channel that ships first.
 *
 * Layout, top to bottom: a header (logo, app name, which run and which day);
 * the headline; a three-figure count by urgency; one section per kind of alert,
 * most costly to ignore first; a footer saying how often this arrives, and
 * buttons into the dashboard. Everything stays within Adaptive Cards 1.4,
 * which is what Teams renders for workflow-posted cards.
 */

const SEVERITY_COLOUR: Record<Severity, string> = {
  critical: 'attention',
  warning: 'warning',
  info: 'accent',
};

const WEEKDAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * The site's own address, for links back into it -- or null, and the card
 * simply has no links. From `APP_URL` in the API's environment: the request a
 * Function receives behind Static Web Apps is not a reliable source for the
 * public hostname, and a link to the wrong host is worse than none.
 */
function siteUrl(raw: string | undefined): string | null {
  const url = raw?.trim().replace(/\/+$/, '');
  return url && /^https?:\/\//.test(url) ? url : null;
}

function alertLink(alert: Alert, base: string | null): string | null {
  if (!base) return null;
  if (alert.tool_id) return `${base}/tools/${encodeURIComponent(alert.tool_id)}`;
  if (alert.product_id) return `${base}/products/${encodeURIComponent(alert.product_id)}`;
  return null;
}

const openAction = (url: string | null, title: string) =>
  url ? { selectAction: { type: 'Action.OpenUrl', url, title } } : {};

/** "IN 5 DAYS", "TODAY", "8 DAYS OVERDUE": the one thing to read before anything else. */
function whenLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return 'TODAY';
  if (days === 1) return 'TOMORROW';
  if (days === -1) return '1 DAY OVERDUE';
  return days > 0 ? `IN ${days} DAYS` : `${-days} DAYS OVERDUE`;
}

/** "Tools & subscriptions: 2 urgent items" -> "2 urgent items"; the prefix becomes the eyebrow instead. */
function headline(title: string): string {
  const rest = title.startsWith(SUBJECT_PREFIX) ? title.slice(SUBJECT_PREFIX.length) : title;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function dayLabel(today: IsoDate): string {
  return `${WEEKDAY[isoWeekday(today) - 1]}, ${formatDate(today)}`;
}

/** Logo, app name, and which run this is. The logo only when the site's address is known. */
function header(payload: NotificationPayload, base: string | null, today: IsoDate | null): unknown {
  const run = payload.kind === 'digest' ? 'Weekly summary' : 'Daily reminder';
  const text = [
    {
      type: 'TextBlock',
      text: SUBJECT_PREFIX.replace(/:\s*$/, '').toUpperCase(),
      size: 'Small',
      weight: 'Bolder',
      isSubtle: true,
      spacing: 'None',
      wrap: true,
    },
    {
      type: 'TextBlock',
      text: today ? `${run} · ${dayLabel(today)}` : run,
      size: 'Small',
      isSubtle: true,
      spacing: 'None',
      wrap: true,
    },
  ];
  if (!base) return { type: 'Container', items: text };
  return {
    type: 'ColumnSet',
    columns: [
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'Center',
        items: [{ type: 'Image', url: `${base}/apple-touch-icon.png`, width: '32px', altText: 'HARTS' }],
      },
      { type: 'Column', width: 'stretch', verticalContentAlignment: 'Center', items: text },
    ],
  };
}

/** Three figures across the top -- urgent, action needed, for information -- so the scale is read at a glance. */
function countStrip(alerts: Alert[]): unknown {
  const tile = (severity: Severity, label: string) => {
    const n = alerts.filter((a) => a.severity === severity).length;
    return {
      type: 'Column',
      width: 'stretch',
      items: [
        {
          type: 'TextBlock',
          text: String(n),
          size: 'ExtraLarge',
          weight: 'Bolder',
          color: n > 0 ? SEVERITY_COLOUR[severity] : 'default',
          isSubtle: n === 0,
          spacing: 'None',
        },
        { type: 'TextBlock', text: label, size: 'Small', isSubtle: true, spacing: 'None', wrap: true },
      ],
    };
  };
  return {
    type: 'ColumnSet',
    spacing: 'Medium',
    columns: [tile('critical', 'Urgent'), tile('warning', 'Action needed'), tile('info', 'For information')],
  };
}

/**
 * One alert: a dot in its urgency colour, the title with how soon on the
 * right, then the sentence that carries the amount, the date or the
 * instruction, then who owns it. Tapping it opens that tool.
 */
function alertRow(alert: Alert, base: string | null): unknown {
  const colour = SEVERITY_COLOUR[alert.severity];
  const when = whenLabel(alert.days_until);
  const owner = alert.owner_name ?? alert.owner_email;

  return {
    type: 'ColumnSet',
    spacing: 'Medium',
    ...openAction(alertLink(alert, base), `Open ${alert.tool_name}`),
    columns: [
      // A dot in the urgency colour. Text colour, not a column background:
      // Teams draws container styles as faint tints that all but vanish in
      // dark mode, while coloured text stays vivid in every theme.
      { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: '●', color: colour, size: 'Small' }] },
      {
        type: 'Column',
        width: 'stretch',
        items: [
          {
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'stretch',
                items: [{ type: 'TextBlock', text: alert.title, weight: 'Bolder', wrap: true }],
              },
              ...(when
                ? [
                    {
                      type: 'Column',
                      width: 'auto',
                      items: [
                        {
                          type: 'TextBlock',
                          text: when,
                          size: 'Small',
                          weight: 'Bolder',
                          color: colour,
                          horizontalAlignment: 'Right',
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
          { type: 'TextBlock', text: alert.detail, wrap: true, spacing: 'Small' },
          owner
            ? { type: 'TextBlock', text: `Owner: ${owner}`, size: 'Small', isSubtle: true, spacing: 'Small', wrap: true }
            : { type: 'TextBlock', text: 'No owner assigned', size: 'Small', color: 'warning', spacing: 'Small' },
        ],
      },
    ],
  };
}

/**
 * Records missing details, as a table: what the tool is, what to fill in, who
 * should. The same sentence on every row ("Without them it cannot be tracked
 * or chased") said nothing the section heading does not.
 */
function missingTable(alerts: Alert[], base: string | null): unknown[] {
  const cell = (text: string, extra: Record<string, unknown> = {}) => ({
    type: 'TextBlock',
    text,
    wrap: true,
    spacing: 'None',
    ...extra,
  });
  const row = (columns: unknown[], extra: Record<string, unknown> = {}) => ({
    type: 'ColumnSet',
    spacing: 'Small',
    columns: columns.map((items, i) => ({ type: 'Column', width: [3, 4, 3][i], items: [items] })),
    ...extra,
  });

  return [
    {
      type: 'TextBlock',
      text: 'Fill these in so their renewals and payments can be tracked.',
      size: 'Small',
      isSubtle: true,
      wrap: true,
      spacing: 'Small',
    },
    row(
      [
        cell('TOOL', { size: 'Small', weight: 'Bolder', isSubtle: true }),
        cell('MISSING', { size: 'Small', weight: 'Bolder', isSubtle: true }),
        cell('OWNER', { size: 'Small', weight: 'Bolder', isSubtle: true }),
      ],
      { spacing: 'Medium' },
    ),
    ...alerts.map((alert) => {
      const owner = alert.owner_name ?? alert.owner_email;
      return row(
        [
          cell(alert.tool_name, { weight: 'Bolder' }),
          cell(alert.missing?.join(', ') ?? alert.detail),
          owner ? cell(owner) : cell('Unassigned', { color: 'warning' }),
        ],
        { separator: true, ...openAction(alertLink(alert, base), `Open ${alert.tool_name}`) },
      );
    }),
  ];
}

export interface Mention {
  name: string;
  /**
   * Who Teams should resolve: their Microsoft sign-in name (UPN) or their
   * Entra object ID. Teams accepts nothing else -- a mailbox alias that is not
   * the UPN still renders as a highlighted name, but opens no profile and
   * notifies nobody.
   */
  id: string;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const OBJECT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "jane.doe@x.com" -> "Jane Doe", for an entry given without a name. */
function nameFromEmail(email: string): string {
  return email
    .split('@')[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * The "Tag on urgent reminders" setting, as people. Each entry is
 * "Name <sign-in>" or a bare sign-in, separated by commas, semicolons or new
 * lines, where the sign-in is a UPN (an email-shaped address) or an Entra
 * object ID. An object ID always resolves, so it is the fix for someone whose
 * email differs from their UPN; it needs a name, since none can be read from
 * it. Anything else is dropped rather than sent to Teams as a mention it
 * cannot resolve.
 */
export function parseMentions(raw: string): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const entry of raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const named = entry.match(/^(.*?)\s*<([^<>\s]+)>$/);
    const id = (named ? named[2]! : entry).trim();
    const name = named?.[1]?.trim();
    if (!EMAIL_RE.test(id) && !(OBJECT_ID_RE.test(id) && name)) continue;
    if (seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({ name: name || nameFromEmail(id), id });
  }
  return out;
}

/**
 * Who to tag, and the line that tags them -- or nothing.
 *
 * Only when something is due within the window, or already overdue. A card
 * about a renewal a month out, or a record missing its cost, tags nobody: a
 * mention on every card is a mention people learn to ignore, which is the one
 * thing it exists to prevent.
 */
function mentionLine(alerts: Alert[], mentions: Mention[], withinDays: number) {
  if (mentions.length === 0) return null;
  const soon = alerts.filter((a) => a.days_until !== null && a.days_until <= withinDays).length;
  if (soon === 0) return null;

  const window = withinDays === 7 ? 'a week' : `${withinDays} day${withinDays === 1 ? '' : 's'}`;
  const tags = mentions.map((m) => `<at>${m.name}</at>`).join(', ');
  return {
    block: {
      type: 'TextBlock',
      text: `${tags} — ${soon} ${soon === 1 ? 'item needs' : 'items need'} action within ${window}.`,
      wrap: true,
      weight: 'Bolder',
      spacing: 'Small',
    },
    entities: mentions.map((m) => ({
      type: 'mention',
      text: `<at>${m.name}</at>`,
      mentioned: { id: m.id, name: m.name },
    })),
  };
}

/**
 * One line of plain text saying what the card is about: "1 urgent item needs
 * attention: test-2 renews tomorrow". Teams shows "No message preview" for a
 * card posted by the Workflows bot, and the card format has no field for one,
 * so this travels beside the card for the workflow to post as text (see
 * DEPLOYMENT.md, step 5), and as the card's fallback text.
 */
export function cardSummary(payload: NotificationPayload): string {
  const lead = headline(payload.title);
  const [first, ...rest] = payload.alerts;
  if (!first) return lead;
  const more = rest.length > 0 ? ` and ${rest.length} more` : '';
  return `${lead}: ${first.title}${more}`;
}

export interface TeamsCardOptions {
  /** The site's address (`APP_URL`), for the logo and every link. No links without it. */
  appUrl?: string;
  /** The business date of the run, for the header. */
  today?: IsoDate;
  /** People to @mention when something is due within `mentionWithinDays`. */
  mentions?: Mention[];
  mentionWithinDays?: number;
}

export function buildTeamsCard(payload: NotificationPayload, options: TeamsCardOptions = {}): unknown {
  const base = siteUrl(options.appUrl);

  const body: unknown[] = [
    header(payload, base, options.today ?? null),
    {
      type: 'TextBlock',
      text: headline(payload.title),
      size: 'Large',
      weight: 'Bolder',
      wrap: true,
      spacing: 'Medium',
    },
  ];
  const tagged = mentionLine(payload.alerts, options.mentions ?? [], options.mentionWithinDays ?? 7);
  if (tagged) body.push(tagged.block);
  if (payload.subtitle) {
    body.push({ type: 'TextBlock', text: payload.subtitle, wrap: true, isSubtle: true, spacing: 'Small' });
  }
  if (payload.alerts.length > 0) body.push(countStrip(payload.alerts));

  for (const section of groupedSections(payload.alerts)) {
    body.push({
      type: 'TextBlock',
      text: `${section.heading} (${section.alerts.length})`,
      wrap: true,
      weight: 'Bolder',
      spacing: 'Large',
      separator: true,
    });
    // Capped so one very noisy day cannot produce a card Teams refuses to render.
    const shown = section.alerts.slice(0, 10);
    if (shown[0]?.rule === 'missing_data') body.push(...missingTable(shown, base));
    else for (const alert of shown) body.push(alertRow(alert, base));
    if (section.alerts.length > 10) {
      body.push({
        type: 'TextBlock',
        text: `...and ${section.alerts.length - 10} more in the dashboard`,
        wrap: true,
        isSubtle: true,
        size: 'Small',
      });
    }
  }

  body.push({
    type: 'TextBlock',
    text:
      payload.kind === 'digest'
        ? 'Weekly summary of everything coming up, including items already reminded about.'
        : 'Checked every morning. Each reminder is sent once per stage; overdue payments repeat weekly until marked paid.',
    size: 'Small',
    isSubtle: true,
    wrap: true,
    separator: true,
    spacing: 'Large',
  });

  const summary = cardSummary(payload);
  return {
    type: 'message',
    summary,
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          fallbackText: summary,
          // Teams otherwise renders a card at a fixed narrow width, which
          // wraps every detail line two or three times.
          // Each <at>Name</at> in the text must match an entity here, or
          // Teams shows it as plain text and notifies nobody.
          msteams: { width: 'Full', ...(tagged ? { entities: tagged.entities } : {}) },
          body,
          ...(base
            ? {
                actions: [
                  { type: 'Action.OpenUrl', title: 'Open the dashboard', url: base, style: 'positive' },
                  { type: 'Action.OpenUrl', title: 'View all tools', url: `${base}/tools` },
                ],
              }
            : {}),
        },
      },
    ],
  };
}

export const teamsChannel: Channel = {
  name: 'teams',

  isConfigured(settings, env) {
    return Boolean(settings.teams_webhook_url || env['TEAMS_WEBHOOK_URL']);
  },

  async send(payload, settings, env) {
    const url = settings.teams_webhook_url || env['TEAMS_WEBHOOK_URL'] || '';
    if (!url) {
      return { channel: 'teams', status: 'skipped', detail: 'no webhook URL configured' };
    }

    const card = buildTeamsCard(payload, {
      appUrl: env['APP_URL'],
      today: todayInTimezone(settings.timezone),
      mentions: parseMentions(settings.teams_mentions),
      mentionWithinDays: settings.teams_mention_days,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(card),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return {
          channel: 'teams',
          status: 'failed',
          detail: `webhook returned ${response.status} ${text.slice(0, 200)}`.trim(),
        };
      }
      return { channel: 'teams', status: 'sent', detail: `posted ${payload.alerts.length} alert(s)` };
    } catch (error) {
      return {
        channel: 'teams',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
