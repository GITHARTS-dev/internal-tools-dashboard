import type { Channel } from './types';
import { formatAlertsText, summaryLine } from './format';
import type { AppSettings } from '../../shared/types';

/**
 * Email, over HTTP.
 *
 * Worth knowing: a Cloudflare Worker cannot open a raw SMTP connection, so
 * "send through our mailbox with an app password" is not available here. Both
 * supported providers are HTTP APIs instead:
 *
 *   graph  -- Microsoft Graph sendMail, using the M365 tenant the company
 *             already pays for. Mail genuinely comes from your own domain and
 *             costs nothing extra. Needs an Entra app registration with the
 *             Mail.Send application permission, then three secrets.
 *   resend -- a standalone sending service, ~3,000 emails/month free. Quicker
 *             to set up (one API key), but needs DNS records to send from your
 *             domain rather than theirs.
 *
 * Until one is configured this channel reports `skipped` and sends nothing.
 * Wiring it up later is configuration only -- no code change.
 */

async function graphToken(env: Record<string, string | undefined>): Promise<string> {
  const tenant = env['MS_TENANT_ID'];
  const clientId = env['MS_CLIENT_ID'];
  const clientSecret = env['MS_CLIENT_SECRET'];
  if (!tenant || !clientId || !clientSecret) throw new Error('Microsoft Graph credentials are incomplete');

  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    throw new Error(`Graph token request failed: ${response.status}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Graph token response contained no access_token');
  return data.access_token;
}

async function sendViaGraph(
  env: Record<string, string | undefined>,
  from: string,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const token = await graphToken(env);
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: text },
          toRecipients: to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Graph sendMail failed: ${response.status} ${detail.slice(0, 200)}`);
  }
}

async function sendViaResend(
  env: Record<string, string | undefined>,
  from: string,
  to: string[],
  subject: string,
  text: string,
): Promise<void> {
  const apiKey = env['RESEND_API_KEY'];
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend failed: ${response.status} ${detail.slice(0, 200)}`);
  }
}

function recipients(settings: AppSettings): string[] {
  return settings.email_to
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const emailChannel: Channel = {
  name: 'email',

  isConfigured(settings, env) {
    const provider = env['EMAIL_PROVIDER'];
    if (!provider || provider === 'none') return false;
    if (!settings.email_from || recipients(settings).length === 0) return false;
    if (provider === 'graph') {
      return Boolean(env['MS_TENANT_ID'] && env['MS_CLIENT_ID'] && env['MS_CLIENT_SECRET']);
    }
    if (provider === 'resend') return Boolean(env['RESEND_API_KEY']);
    return false;
  },

  async send(payload, settings, env) {
    if (!this.isConfigured(settings, env)) {
      return {
        channel: 'email',
        status: 'skipped',
        detail: 'email is not configured yet (set EMAIL_PROVIDER plus its credentials)',
      };
    }

    const to = recipients(settings);
    const body = `${summaryLine(payload.alerts)}\n\n${payload.text || formatAlertsText(payload.alerts)}\n`;

    try {
      if (env['EMAIL_PROVIDER'] === 'graph') {
        await sendViaGraph(env, settings.email_from, to, payload.title, body);
      } else {
        await sendViaResend(env, settings.email_from, to, payload.title, body);
      }
      return { channel: 'email', status: 'sent', detail: `emailed ${to.length} recipient(s)` };
    } catch (error) {
      return {
        channel: 'email',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
