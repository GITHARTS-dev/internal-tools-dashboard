import { useEffect, useState } from 'react';
import { api, ApiError, type ImportResult, type ReminderRunResponse } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, Banner, EmptyState, Loading, useToast } from '../components/ui';
import { AlertRow } from '../components/ui';
import { IconRefresh, IconSend } from '../components/icons';
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
      reporting_currency: s.reporting_currency,
      fx_auto_refresh: String(s.fx_auto_refresh),
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
        reporting_currency: (form['reporting_currency'] ?? 'INR').toUpperCase(),
        fx_auto_refresh: form['fx_auto_refresh'] ?? 'true',
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
      <DataPanel />

      <section className="card">
        <div className="card-head">
          <h2>Where reminders go</h2>
        </div>
        <p className="card-sub">
          A channel only sends when it has what it needs. Nothing here is guesswork — this is the
          live state the reminder job will see.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {data.channels.map((channel) => (
            <div key={channel.name} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 92 }}>
                <Badge tone={channel.configured ? 'good' : 'info'} dot>
                  {channel.configured ? 'Ready' : 'Not set up'}
                </Badge>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{channel.name}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                  {CHANNEL_HELP[channel.name]}
                </div>
              </div>
              {/* Console needs no proving; the other two do. */}
              {channel.name !== 'console' ? (
                <TestChannelButton name={channel.name} enabled={channel.configured} />
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <FxPanel />

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

            <div className="fieldset-title">Reporting</div>

            <div className="field">
              <label htmlFor="reporting_currency">Report combined totals in</label>
              <input
                id="reporting_currency"
                value={form['reporting_currency'] ?? ''}
                maxLength={3}
                style={{ textTransform: 'uppercase' }}
                onChange={(e) => set('reporting_currency', e.target.value)}
              />
              <span className="help">
                The currency the cost summary is expressed in. Amounts in other currencies are
                converted at ECB rates and always labelled as converted.
              </span>
            </div>

            <div className="field">
              <label htmlFor="fx_auto_refresh">Fetch exchange rates automatically</label>
              <select
                id="fx_auto_refresh"
                value={form['fx_auto_refresh'] ?? 'true'}
                onChange={(e) => set('fx_auto_refresh', e.target.value)}
              >
                <option value="true">Yes, with the daily job</option>
                <option value="false">No, I will fetch them by hand</option>
              </select>
              <span className="help">
                The daily job asks the ECB for any newly published month before sending reminders.
              </span>
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
 * Send one real message down a channel.
 *
 * Pasting a webhook URL is the step most likely to be wrong, and without this
 * the only way to find out is to wait for tomorrow's cron. The test records
 * nothing, so it cannot consume a real reminder's dedupe key.
 */
function TestChannelButton({ name, enabled }: { name: string; enabled: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const { result } = await api.testChannel(name);
      if (result.status === 'sent') toast(`Test message sent to ${name}. Go and look.`);
      else toast(`${name}: ${result.detail}`, 'error');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `Could not reach ${name}.`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn sm"
      onClick={send}
      disabled={!enabled || busy}
      title={enabled ? `Send a test message to ${name}` : `Set ${name} up first`}
    >
      <IconSend size={13} />
      {busy ? 'Sending…' : 'Send test'}
    </button>
  );
}

/**
 * Exchange rates.
 *
 * Shows what is stored rather than only offering a button, because the useful
 * question here is "can the cost summary actually add these currencies up",
 * and the honest answer is the range of months on hand.
 */
function FxPanel() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.fxStatus(), []);
  const [busy, setBusy] = useState(false);
  const [from, setFrom] = useState('');

  async function refresh() {
    setBusy(true);
    try {
      const result = await api.refreshFx(from || undefined);
      toast(
        result.missing.length > 0
          ? `Saved ${result.saved} rates. The ECB publishes none for: ${result.missing.join(', ')}.`
          : `Saved ${result.saved} rates, ${result.from} to ${result.to}.`,
      );
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not reach the ECB.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { status } = data;
  const uncovered = data.currencies_in_use.filter(
    (c) => c !== 'EUR' && c !== data.reporting_currency && !status.currencies.includes(c),
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>Exchange rates</h2>
        <span className="hint">European Central Bank</span>
      </div>
      <p className="card-sub">
        Only needed to add different currencies together. Each amount is converted at the rate of
        the month it belongs to, so a past year's total never changes.
      </p>

      {status.months === 0 ? (
        <Banner tone="warning">
          No rates stored yet. Until you fetch some, the cost summary can only count amounts already
          in {data.reporting_currency}.
        </Banner>
      ) : (
        <dl className="detail-grid" style={{ marginBottom: 16 }}>
          <div className="detail-item">
            <dt>Months stored</dt>
            <dd>
              {status.months} ({status.earliest} to {status.latest})
            </dd>
          </div>
          <div className="detail-item">
            <dt>Currencies</dt>
            <dd>{status.currencies.join(', ') || '--'}</dd>
          </div>
          <div className="detail-item">
            <dt>Last fetched</dt>
            <dd>
              {status.last_fetched_at
                ? new Date(status.last_fetched_at).toLocaleString()
                : 'Never'}
            </dd>
          </div>
          <div className="detail-item">
            <dt>Reporting in</dt>
            <dd>{data.reporting_currency}</dd>
          </div>
        </dl>
      )}

      {uncovered.length > 0 ? (
        <Banner tone="warning">
          In use but with no stored rate: {uncovered.join(', ')}. Amounts in{' '}
          {uncovered.length === 1 ? 'that currency' : 'those currencies'} are left out of combined
          totals until a rate exists.
        </Banner>
      ) : null}

      <div className="toolbar" style={{ marginTop: 14 }}>
        <div className="field" style={{ maxWidth: 180 }}>
          <label htmlFor="fx-from">Fetch from month</label>
          <input
            id="fx-from"
            value={from}
            placeholder="2024-01"
            onChange={(e) => setFrom(e.target.value)}
          />
          <span className="help">Blank fetches the last 24 months.</span>
        </div>
        <button type="button" className="btn primary" onClick={refresh} disabled={busy}>
          <IconRefresh size={14} />
          {busy ? 'Fetching…' : 'Fetch rates now'}
        </button>
      </div>

      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
        The ECB publishes a month's average only once that month has ended, so the current month is
        always absent. Totals covering it fall back to the most recent month available.
      </p>
    </section>
  );
}

/**
 * Bring the demo data in or out, or wipe everything to start fresh.
 *
 * "Remove demo data" only touches the built-in sample rows, so tools someone
 * entered themselves survive it. "Delete everything" does not, which is why it
 * asks first and says how much it is about to remove.
 */
function DataPanel() {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.dataStatus(), []);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await action();
      toast(message);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That did not work.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!data) return null;

  const { status, enabled } = data;

  function clearAll() {
    const ok = window.confirm(
      `Delete all ${status.tools} tools and ${status.payments} payments, including your own? This cannot be undone.`,
    );
    if (ok) run(() => api.clearAllData(), 'All data deleted. You are starting fresh.');
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Sample data</h2>
      </div>
      <p className="card-sub">
        {status.tools === 0
          ? 'The dashboard is empty.'
          : `${status.tools} tool${status.tools === 1 ? '' : 's'} and ${status.payments} payment${status.payments === 1 ? '' : 's'} stored: ${status.demo_tools} demo, ${status.own_tools} yours.`}{' '}
        Load the demo data to see every alert in action, or clear it to start from scratch.
      </p>

      {enabled ? null : <Banner tone="info">These controls are switched off in production.</Banner>}

      <div className="toolbar">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !enabled}
          onClick={() => run(() => api.loadDemoData(), 'Demo data loaded.')}
        >
          {status.demo_tools > 0 ? 'Reload demo data' : 'Load demo data'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !enabled || status.demo_tools === 0}
          title={status.demo_tools === 0 ? 'There is no demo data to remove' : 'Keeps anything you added yourself'}
          onClick={() => run(() => api.removeDemoData(), 'Demo data removed.')}
        >
          Remove demo data
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={busy || !enabled || status.tools === 0}
          onClick={clearAll}
        >
          Delete everything
        </button>
      </div>
    </section>
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
