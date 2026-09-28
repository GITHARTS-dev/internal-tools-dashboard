import type { Channel, NotificationPayload } from './types';
import { SUBJECT_PREFIX, groupedSections, summaryLine } from './format';
import type { Alert } from '../../shared/types';

/**
 * Microsoft Teams, via an incoming webhook URL.
 *
 * The payload is an Adaptive Card wrapped in a `message` attachment, which is
 * the shape both a Power Automate "Teams webhook request" trigger and a legacy
 * Office 365 connector accept. Microsoft has been retiring the old connectors,
 * so a Workflows URL is the one to create today -- either works here.
 *
 * Where the card lands is the workflow's business, not this file's. Ours posts
 * it to each recipient as a personal chat from the Flow bot rather than into a
 * channel (DEPLOYMENT.md, step 5), so changing who is told needs no deploy.
 *
 * Needs nothing but a URL pasted into Settings: no app registration, no admin
 * consent, no credentials. That is why it is the channel that ships first.
 */

const SEVERITY_COLOUR: Record<string, string> = {
  critical: 'attention',
  warning: 'warning',
  info: 'default',
};

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

/**
 * One alert: what happened, then the sentence that says what it costs and by
 * when, then who owns it.
 *
 * The detail line is the useful part -- the amount, the cancel-by date, the
 * instruction -- and it used to be dropped for any alert with a date, leaving
 * "in 5 days · owner" under a title that had already said "in 5 days".
 */
function alertBlock(alert: Alert, base: string | null): unknown {
  const owner = alert.owner_name ?? alert.owner_email;
  const link = alertLink(alert, base);

  return {
    type: 'Container',
    spacing: 'Medium',
    ...(link ? { selectAction: { type: 'Action.OpenUrl', url: link, title: `Open ${alert.tool_name}` } } : {}),
    items: [
      {
        type: 'TextBlock',
        text: alert.title,
        wrap: true,
        weight: 'Bolder',
        color: SEVERITY_COLOUR[alert.severity] ?? 'default',
      },
      { type: 'TextBlock', text: alert.detail, wrap: true, spacing: 'Small' },
      ...(owner
        ? [{ type: 'TextBlock', text: `Owner: ${owner}`, wrap: true, isSubtle: true, size: 'Small', spacing: 'Small' }]
        : []),
    ],
  };
}

/** "Tools & subscriptions: 2 urgent items" -> "2 urgent items"; the prefix becomes the eyebrow instead. */
function headline(title: string): string {
  const rest = title.startsWith(SUBJECT_PREFIX) ? title.slice(SUBJECT_PREFIX.length) : title;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function buildTeamsCard(payload: NotificationPayload, appUrl?: string): unknown {
  const base = siteUrl(appUrl);

  const body: unknown[] = [
    {
      type: 'TextBlock',
      text: SUBJECT_PREFIX.replace(/:\s*$/, '').toUpperCase(),
      size: 'Small',
      weight: 'Bolder',
      isSubtle: true,
      wrap: true,
    },
    { type: 'TextBlock', text: headline(payload.title), size: 'Large', weight: 'Bolder', wrap: true, spacing: 'None' },
    {
      type: 'TextBlock',
      text: payload.subtitle ?? summaryLine(payload.alerts),
      wrap: true,
      isSubtle: true,
      spacing: 'Small',
    },
  ];

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
    for (const alert of section.alerts.slice(0, 10)) body.push(alertBlock(alert, base));
    if (section.alerts.length > 10) {
      body.push({
        type: 'TextBlock',
        text: `...and ${section.alerts.length - 10} more`,
        wrap: true,
        isSubtle: true,
        size: 'Small',
      });
    }
  }

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          // Teams otherwise renders a card at a fixed narrow width, which
          // wraps every detail line two or three times.
          msteams: { width: 'Full' },
          body,
          ...(base ? { actions: [{ type: 'Action.OpenUrl', title: 'Open the dashboard', url: base }] } : {}),
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

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildTeamsCard(payload, env['APP_URL'])),
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
