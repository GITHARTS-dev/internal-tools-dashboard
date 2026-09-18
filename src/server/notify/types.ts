import type { Alert, AppSettings } from '../../shared/types';

export interface NotificationPayload {
  /** One-line subject: what this message is about. */
  title: string;
  /** Plain-text body, used verbatim by channels without rich formatting. */
  text: string;
  alerts: Alert[];
  kind: 'alerts' | 'digest';
}

export interface ChannelResult {
  channel: string;
  status: 'sent' | 'skipped' | 'failed';
  detail: string;
}

export interface Channel {
  name: string;
  /**
   * Whether this channel has what it needs to actually send. An unconfigured
   * channel reports `skipped` rather than failing the run -- that is how email
   * stays inert until credentials exist, without any code change.
   */
  isConfigured(settings: AppSettings, env: Record<string, string | undefined>): boolean;
  send(
    payload: NotificationPayload,
    settings: AppSettings,
    env: Record<string, string | undefined>,
  ): Promise<ChannelResult>;
}
