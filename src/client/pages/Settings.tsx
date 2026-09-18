import { useEffect, useState } from 'react';
import { api, ApiError, type ImportResult, type ReminderRunResponse } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Banner, EmptyState, Loading, useToast } from '../components/ui';
import { AlertRow } from '../components/ui';
import { formatDate } from '../../shared/dates';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const CHANNEL_HELP: Record<string, string> = {
  console:
    'Always on. Writes what would be sent to the server log, so the reminder engine can be watched working with no credentials at all.',
  teams:
    'Paste an incoming webhook URL from a Teams channel (create one via Workflows → “When a Teams webhook request is received”). No app registration or admin consent needed.',
  email:
    'Inert until credentials exist. Set EMAIL_PROVIDER to “graph” (uses your existing M365 tenant, sends from your own domain) or “resend”, plus the matching secrets.',
};

export default function Settings() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.settings(), []);

  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setForm({
      timezone: s.timezone,
      default_currency: s.default_currency,
      renewal_lead_days: s.renewal_lead_days.join(', '),
      payment_lead_days: s.payment_lead_days.join(', '),
      notice_lead_days: s.notice_lead_days.join(', '),
      seat_underuse_ratio: String(s.seat_underuse_ratio),
      digest_weekday: String(s.digest_weekday),
      digest_horizon_days: String(s.digest_horizon_days),
      teams_webhook_url: s.teams_webhook_url,
      email_from: s.email_from,
      email_to: s.email_to,
    });
  }, [data]);

  function set(key: string, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  /** '60, 30, 14' in the box becomes '[60,30,14]' in storage. */
  function parseLeadDays(input: string): string {
    const days = input
      .split(/[,\s]+/)
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0);
    return JSON.stringify([...new Set(days)].sort((a, b) => b - a));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.updateSettings({
        timezone: form['timezone'] ?? '',
        default_currency: (form['default_currency'] ?? '').toUpperCase(),
        renewal_lead_days: parseLeadDays(form['renewal_lead_days'] ?? ''),
        payment_lead_days: parseLeadDays(form['payment_lead_days'] ?? ''),
        notice_lead_days: parseLeadDays(form['notice_lead_days'] ?? ''),
        seat_underuse_ratio: form['seat_underuse_ratio'] ?? '0.7',
        digest_weekday: form['digest_weekday'] ?? '1',
        digest_horizon_days: form['digest_horizon_days'] ?? '45',
        teams_webhook_url: form['teams_webhook_url'] ?? '',
        email_from: form['email_from'] ?? '',
        email_to: form['email_to'] ?? '',
      });
      toast('Settings saved.');
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save settings.', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <Loading rows={3} />;
  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>Where reminders go</h2>
        </div>
        <p className="card-sub">
          A channel only sends when it has what it needs. Nothing here is guesswork — this is the
          live state the reminder job will see.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.channels.map((channel) => (
            <div key={channel.name} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 92 }}>
                <Badge tone={channel.configured ? 'good' : 'info'} dot>
                  {channel.configured ? 'Ready' : 'Not set up'}
                </Badge>
              </div>
              <div>
                <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{channel.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {CHANNEL_HELP[channel.name]}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <form onSubmit={save}>
        <section className="card">
          <div className="card-head">
            <h2>Reminder rules</h2>
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="renewal_lead_days">Warn before a renewal (days)</label>
              <input
                id="renewal_lead_days"
                value={form['renewal_lead_days'] ?? ''}
                onChange={(e) => set('renewal_lead_days', e.target.value)}
              />
              <span className="help">One reminder per threshold crossed, not one per day.</span>
            </div>

            <div className="field">
              <label htmlFor="payment_lead_days">Warn before a payment is due (days)</label>
              <input
                id="payment_lead_days"
                value={form['payment_lead_days'] ?? ''}
                onChange={(e) => set('payment_lead_days', e.target.value)}
              />
              <span className="help">Overdue bills are then chased once a week.</span>
            </div>

            <div className="field">
              <label htmlFor="notice_lead_days">Warn before a cancellation deadline (days)</label>
              <input
                id="notice_lead_days"
                value={form['notice_lead_days'] ?? ''}
                onChange={(e) => set('notice_lead_days', e.target.value)}
              />
              <span className="help">The last day to cancel without paying for another period.</span>
            </div>

            <div className="field">
              <label htmlFor="seat_underuse_ratio">Flag idle seats below</label>
              <input
                id="seat_underuse_ratio"
                value={form['seat_underuse_ratio'] ?? ''}
                onChange={(e) => set('seat_underuse_ratio', e.target.value)}
              />
              <span className="help">0.7 means “fewer than 70% of paid seats are in use”.</span>
            </div>

            <div className="field">
              <label htmlFor="digest_weekday">Weekly digest day</label>
              <select
                id="digest_weekday"
                value={form['digest_weekday'] ?? '1'}
                onChange={(e) => set('digest_weekday', e.target.value)}
              >
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={String(i + 1)}>
                    {day}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="digest_horizon_days">Digest looks ahead (days)</label>
              <input
                id="digest_horizon_days"
                value={form['digest_horizon_days'] ?? ''}
                onChange={(e) => set('digest_horizon_days', e.target.value)}
              />
            </div>

            <div className="fieldset-title">Delivery</div>

            <div className="field wide">
              <label htmlFor="teams_webhook_url">Teams webhook URL</label>
              <input
                id="teams_webhook_url"
                value={form['teams_webhook_url'] ?? ''}
                onChange={(e) => set('teams_webhook_url', e.target.value)}
                placeholder="https://prod-XX.westus.logic.azure.com:443/workflows/..."
              />
              <span className="help">Paste it here and Teams reminders start working immediately.</span>
            </div>

            <div className="field">
              <label htmlFor="email_from">Send email from</label>
              <input
                id="email_from"
                value={form['email_from'] ?? ''}
                onChange={(e) => set('email_from', e.target.value)}
                placeholder="tools-alerts@yourcompany.com"
              />
            </div>

            <div className="field">
              <label htmlFor="email_to">Send email to</label>
              <input
                id="email_to"
                value={form['email_to'] ?? ''}
                onChange={(e) => set('email_to', e.target.value)}
                placeholder="finance@yourcompany.com, ops@yourcompany.com"
              />
            </div>

            <div className="fieldset-title">Regional</div>

            <div className="field">
              <label htmlFor="timezone">Business timezone</label>
              <input
                id="timezone"
                value={form['timezone'] ?? ''}
                onChange={(e) => set('timezone', e.target.value)}
                placeholder="Asia/Kolkata"
              />
              <span className="help">Decides which calendar day a deadline falls on.</span>
            </div>

            <div className="field">
              <label htmlFor="default_currency">Default currency</label>
              <input
                id="default_currency"
                value={form['default_currency'] ?? ''}
                onChange={(e) => set('default_currency', e.target.value.toUpperCase())}
                maxLength={3}
              />
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: 18 }}>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </section>
      </form>

      <DryRunPanel />
      <ImportPanel onDone={reload} />
    </>
  );
}

/**
 * Preview the reminder job on any date, sending and recording nothing.
 *
 * Runs the same code path as the scheduled job, so this is not an
 * approximation of what would go out -- it is what would go out.
 */
function DryRunPanel() {
  const toast = useToast();
  const [date, setDate] = useState('');
  const [digest, setDigest] = useState(false);
  const [result, setResult] = useState<ReminderRunResponse | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      setResult(await api.dryRun(date || undefined, digest));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not run the preview.', 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Preview reminders</h2>
      </div>
      <p className="card-sub">
        See exactly which reminders would fire on a given day. Nothing is sent and nothing is
        recorded, so this is always safe to run — including against a future date.
      </p>

      <div className="toolbar">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label="Simulate this date"
        />
        <label className="checkline">
          <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} />
          Include the weekly digest
        </label>
        <button type="button" className="btn" onClick={run} disabled={running}>
          {running ? 'Running…' : 'Preview'}
        </button>
      </div>

      {result ? (
        <div style={{ marginTop: 16 }}>
          <Banner tone="info">
            On {formatDate(result.today)} ({result.timezone}), {result.alerts.length} alert
            {result.alerts.length === 1 ? '' : 's'} would be computed.
          </Banner>

          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {result.alert_dispatch.channels.map((channel) => (
              <div key={channel.channel} style={{ fontSize: 13 }}>
                <Badge tone={channel.new_alerts > 0 ? 'warning' : 'info'}>{channel.channel}</Badge>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>
                  {channel.new_alerts > 0
                    ? `would send ${channel.new_alerts} new item${channel.new_alerts === 1 ? '' : 's'}`
                    : channel.detail}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14 }}>
            {result.alerts.length === 0 ? (
              <EmptyState title="Nothing would be sent that day" />
            ) : (
              result.alerts.map((alert) => <AlertRow key={alert.dedupe_key} alert={alert} />)
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * CSV import.
 *
 * Always previewed first: the file is checked row by row and the result shown
 * before anything is written. Nobody should discover what an import does by
 * running it on real data.
 */
function ImportPanel({ onDone }: { onDone: () => void }) {
  const toast = useToast();

  async function downloadTemplate() {
    try {
      await api.downloadCsv('template');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not build that file.', 'error');
    }
  }
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(commit: boolean) {
    if (!csv.trim()) {
      toast('Paste some CSV or choose a file first.', 'error');
      return;
    }
    setBusy(true);
    try {
      const response = await api.importCsv(csv, commit);
      setResult(response);
      if (commit) {
        toast(`Imported: ${response.summary.created} added, ${response.summary.updated} updated.`);
        onDone();
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not read that file.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsv(await file.text());
    setResult(null);
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Import from a spreadsheet</h2>
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => downloadTemplate()}
        >
          Download template
        </button>
      </div>
      <p className="card-sub">
        Rows are matched to existing tools by name, so re-importing an edited export updates in
        place rather than creating duplicates.
      </p>

      <div className="toolbar" style={{ marginBottom: 10 }}>
        <input type="file" accept=".csv,text/csv" onChange={onFile} aria-label="Choose a CSV file" />
      </div>

      <textarea
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value);
          setResult(null);
        }}
        placeholder="…or paste CSV here"
        style={{ width: '100%', minHeight: 110, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
      />

      <div className="toolbar" style={{ marginTop: 10 }}>
        <button type="button" className="btn" onClick={() => run(false)} disabled={busy}>
          Check the file
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => run(true)}
          disabled={busy || !result || result.summary.total === result.summary.rejected}
          title={result ? undefined : 'Check the file first'}
        >
          Import for real
        </button>
      </div>

      {result ? (
        <div style={{ marginTop: 14 }}>
          <Banner tone={result.summary.rejected > 0 ? 'warning' : 'good'}>
            {result.committed ? 'Imported' : 'Would import'}: {result.summary.created} new,{' '}
            {result.summary.updated} updated
            {result.summary.rejected > 0 ? `, ${result.summary.rejected} rejected` : ''}.
          </Banner>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Name</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => (
                  <tr key={`${row.row}-${row.name}`}>
                    <td className="num">{row.row}</td>
                    <td>{row.name || <span className="cell-sub">(blank)</span>}</td>
                    <td>
                      <Badge tone={row.action === 'reject' ? 'critical' : row.action === 'create' ? 'good' : 'info'}>
                        {row.action}
                      </Badge>
                    </td>
                    <td className="cell-sub">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
