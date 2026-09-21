import type { Channel, NotificationPayload } from './types';
import { groupedSections, summaryLine } from './format';
import { formatDate, relativeDays } from '../../shared/dates';
import type { Alert, AppSettings } from '../../shared/types';

/**
 * Microsoft Teams, via an incoming webhook URL.
 *
 * The payload is an Adaptive Card wrapped in a `message` attachment, which is
 * the shape both a Power Automate "Teams webhook request" trigger and a legacy
 * Office 365 connector accept. Microsoft has been retiring the old connectors,
 * so a Workflows URL is the one to create today -- either works here.
 *
 * Needs nothing but a URL pasted into Settings: no app registration, no admin
 * consent, no credentials. That is why it is the channel that ships first.
 */

const SEVERITY_COLOUR: Record<string, string> = {
  critical: 'attention',
  warning: 'warning',
  info: 'default',
};

function alertBlock(alert: Alert): unknown {
  const when =
    alert.days_until === null
      ? ''
      : `${relativeDays(alert.days_until)}${alert.date ? ` · ${formatDate(alert.date)}` : ''}`;
  const owner = alert.owner_name ? ` · ${alert.owner_name}` : '';

  return {
    type: 'Container',
    spacing: 'Small',
    items: [
      {
        type: 'TextBlock',
        text: alert.title,
        wrap: true,
        weight: 'Bolder',
        color: SEVERITY_COLOUR[alert.severity] ?? 'default',
      },
      {
        type: 'TextBlock',
        // An alert with no date has nothing to say about when, so its detail is
        // the useful line. Without this a missing-data alert with an owner
        // rendered as just "· Owner", and told the reader nothing.
        text: (when ? `${when}${owner}` : `${alert.detail}${owner}`).trim(),
        wrap: true,
        isSubtle: true,
        spacing: 'None',
        size: 'Small',
      },
    ],
  };
}

export function buildTeamsCard(payload: NotificationPayload): unknown {
  const body: unknown[] = [
    { type: 'TextBlock', text: payload.title, wrap: true, size: 'Large', weight: 'Bolder' },
    { type: 'TextBlock', text: summaryLine(payload.alerts), wrap: true, isSubtle: true, spacing: 'None' },
  ];

  for (const section of groupedSections(payload.alerts)) {
    body.push({
      type: 'TextBlock',
      text: `${section.heading} (${section.alerts.length})`,
      wrap: true,
      weight: 'Bolder',
      spacing: 'Medium',
      separator: true,
    });
    // Capped so one very noisy day cannot produce a card Teams refuses to render.
    for (const alert of section.alerts.slice(0, 10)) body.push(alertBlock(alert));
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
          body,
        },
      },
    ],
  };
}

export const teamsChannel: Channel = {
  name: 'teams',

  isConfigured(settings: AppSettings, env) {
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
        body: JSON.stringify(buildTeamsCard(payload)),
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
