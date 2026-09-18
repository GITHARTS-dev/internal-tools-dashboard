import type { Channel } from './types';
import { formatAlertsText } from './format';

/**
 * Logs what would be sent instead of sending it.
 *
 * This is the active channel while deployment is on hold: the reminder engine
 * can be watched working end to end without a single credential, a webhook, or
 * anyone's inbox being touched.
 */
export const consoleChannel: Channel = {
  name: 'console',
  isConfigured: () => true,
  async send(payload) {
    const body = `\n=== ${payload.title} ===\n${payload.text || formatAlertsText(payload.alerts)}\n`;
    console.log(body);
    return { channel: 'console', status: 'sent', detail: `logged ${payload.alerts.length} alert(s)` };
  },
};
