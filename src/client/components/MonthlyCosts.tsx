import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { ProductCostsResponse } from '../lib/apiClient';
import { ApiError } from '../lib/errors';
import { Banner, EmptyState, useToast } from './ui';
import { IconEdit } from './icons';
import { monthLabel } from './spend';
import { addMonthsToYearMonth } from '../../shared/fx';
import { formatMoney, parseMoneyInput, toDecimalString } from '../../shared/money';
import type { ProductCost } from '../../shared/types';

/**
 * What a product actually cost, month by month.
 *
 * A product's cloud spend is whatever the bill said, and next month's is
 * unknown, so it is entered as it happens rather than derived from a price. The
 * form is built for the monthly habit: month and provider are the two things
 * that identify a line, so saving the same pair again replaces it, which makes
 * correcting a figure the same gesture as entering one.
 *
 * The status lines above the form say what the dashboard will do with these
 * numbers -- the average it uses and the months it covers -- and warn when last
 * month is still missing, because manual entry only fails one way: by being
 * forgotten while the figures go on looking current.
 */

/** Offered as suggestions only; anything can be typed. */
const PROVIDER_SUGGESTIONS = ['AWS', 'Azure', 'Supabase', 'Vercel', 'Cloudflare', 'GitHub', 'Domain'];

const ROWS_SHOWN = 24;

interface FormState {
  month: string;
  provider: string;
  amount: string;
  currency: string;
  note: string;
}

export default function MonthlyCosts({
  productId,
  data,
  onChanged,
}: {
  productId: string;
  data: ProductCostsResponse;
  onChanged: () => void;
}) {
  const toast = useToast();
  const amountRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const { costs, usage, reporting_currency: reporting } = data;
  const lastMonth = usage.latest_complete_month;
  const thisMonth = addMonthsToYearMonth(lastMonth, 1);

  const blank = (): FormState => ({
    month: lastMonth,
    provider: '',
    amount: '',
    // Whatever was used last is what is likely wanted next.
    currency: costs[0]?.currency ?? 'USD',
    note: '',
  });

  const [form, setForm] = useState<FormState>(blank);
  const [editing, setEditing] = useState<ProductCost | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const providers = useMemo(() => {
    const used = costs.map((c) => c.provider);
    return [...new Set([...used, ...PROVIDER_SUGGESTIONS])];
  }, [costs]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function startEdit(cost: ProductCost) {
    setEditing(cost);
    setErrors({});
    setForm({
      month: cost.month,
      provider: cost.provider,
      amount: toDecimalString(cost.amount, cost.currency),
      currency: cost.currency,
      note: cost.note ?? '',
    });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Wait a frame so the scroll has started before focus moves.
    requestAnimationFrame(() => amountRef.current?.focus());
  }

  function cancelEdit() {
    setEditing(null);
    setErrors({});
    setForm(blank());
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const currency = form.currency.trim().toUpperCase();
    const minor = parseMoneyInput(form.amount, currency || 'USD');
    if (minor === null) {
      setErrors({ amount: 'Enter the amount from the bill, such as 312.50' });
      return;
    }

    setSaving(true);
    setErrors({});
    try {
      await api.recordProductCost(productId, {
        month: form.month,
        provider: form.provider,
        amount: minor,
        currency,
        note: form.note,
      });
      toast(`Saved ${form.provider} for ${monthLabel(form.month, true)}.`);
      // Month and provider stay where they are while the amount and note clear,
      // so a second provider for the same month is two keystrokes away.
      setEditing(null);
      setForm((current) => ({ ...current, amount: '', note: '' }));
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        setErrors(error.fields);
      } else {
        toast(error instanceof ApiError ? error.message : 'Could not save that cost.', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(cost: ProductCost) {
    const what = `${cost.provider} for ${monthLabel(cost.month, true)} (${formatMoney(cost.amount, cost.currency)})`;
    if (!confirm(`Remove ${what}? This is for a figure entered by mistake; it is recorded in the change log.`)) {
      return;
    }
    try {
      await api.deleteProductCost(productId, cost.id);
      toast('Removed.');
      if (editing?.id === cost.id) cancelEdit();
      onChanged();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not remove that.', 'error');
    }
  }

  const counted = usage.window.filter((m) => m.amount !== null);
  const foreign = costs.some((c) => c.currency.toUpperCase() !== reporting.toUpperCase());
  const visible = showAll ? costs : costs.slice(0, ROWS_SHOWN);

  return (
    <section className="card">
      <div className="card-head">
        <h2>Monthly costs</h2>
        <span className="hint">usage-based, entered by hand</span>
      </div>
      <div className="card-sub">
        What this product actually cost each month: cloud bills that move with usage, so they are
        recorded as billed rather than worked out from a price. Enter a month once its bill is
        final. Saving the same month and provider again replaces it.
      </div>

      {/* --------------------------------------------------- what it means */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {data.entry_due ? (
          <Banner tone="warning">
            <span>
              <strong>{monthLabel(lastMonth, true)} has not been entered.</strong> Until it is,
              the estimate below is out of date and the dashboard shows it that way. Bills are
              usually final a few days into the next month.
            </span>
          </Banner>
        ) : null}

        {usage.average_reported !== null ? (
          <p className="usage-line">
            Used on the dashboard:{' '}
            <strong>{formatMoney(usage.average_reported, reporting)}</strong> a month, the average
            of {counted.length === 1 ? 'the one complete month' : `the last ${counted.length} complete months`} entered
            ({counted.map((m) => monthLabel(m.month)).join(', ')}).
            {foreign ? ` Converted to ${reporting} at each month's own exchange rate.` : ''}{' '}
            It is an estimate, not a commitment.
          </p>
        ) : costs.length > 0 ? (
          <p className="usage-line">
            Nothing from the last three complete months is usable yet, so this product adds no
            usage cost to the dashboard.
          </p>
        ) : null}

        {usage.gaps.length > 0 ? (
          <Banner tone="warning">
            <span>
              No exchange rate covers{' '}
              {usage.gaps.map((g) => `${g.currency}${g.month ? ` (${monthLabel(g.month, true)})` : ''}`).join(', ')},
              so {usage.gaps.length === 1 ? 'that month is' : 'those months are'} left out of the
              estimate. <Link to="/settings">Fetch rates in Settings</Link> to include{' '}
              {usage.gaps.length === 1 ? 'it' : 'them'}.
            </span>
          </Banner>
        ) : null}
      </div>

      {/* ----------------------------------------------------------- form */}
      <div ref={formRef}>
        <form onSubmit={submit} noValidate>
          {editing ? (
            <div className="usage-line" style={{ marginBottom: 10 }}>
              Correcting <strong>{editing.provider}</strong> for{' '}
              <strong>{monthLabel(editing.month, true)}</strong>. The month and provider identify
              the line, so they are locked; remove it and add a new one to change either.
            </div>
          ) : null}

          <div className="form-grid cost-form">
            <div className="field">
              <label htmlFor="mc-month">Month</label>
              <input
                id="mc-month"
                type="month"
                value={form.month}
                max={thisMonth}
                placeholder="YYYY-MM"
                disabled={editing !== null}
                onChange={(e) => set('month', e.target.value)}
                aria-invalid={errors['month'] ? 'true' : undefined}
              />
              {errors['month'] ? <span className="error">{errors['month']}</span> : null}
            </div>

            <div className="field">
              <label htmlFor="mc-provider">Provider</label>
              <input
                id="mc-provider"
                list="mc-providers"
                value={form.provider}
                disabled={editing !== null}
                placeholder="AWS"
                onChange={(e) => set('provider', e.target.value)}
                aria-invalid={errors['provider'] ? 'true' : undefined}
              />
              <datalist id="mc-providers">
                {providers.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              {errors['provider'] ? <span className="error">{errors['provider']}</span> : null}
            </div>

            <div className="field">
              <label htmlFor="mc-amount">Amount</label>
              <input
                id="mc-amount"
                ref={amountRef}
                inputMode="decimal"
                value={form.amount}
                placeholder="312.50"
                onChange={(e) => set('amount', e.target.value)}
                aria-invalid={errors['amount'] ? 'true' : undefined}
              />
              {errors['amount'] ? <span className="error">{errors['amount']}</span> : null}
            </div>

            <div className="field">
              <label htmlFor="mc-currency">Currency</label>
              <input
                id="mc-currency"
                value={form.currency}
                maxLength={3}
                style={{ textTransform: 'uppercase' }}
                onChange={(e) => set('currency', e.target.value)}
                aria-invalid={errors['currency'] ? 'true' : undefined}
              />
              {errors['currency'] ? <span className="error">{errors['currency']}</span> : null}
            </div>

            <div className="field wide">
              <label htmlFor="mc-note">Note</label>
              <input
                id="mc-note"
                value={form.note}
                placeholder="Optional, for example: includes the one-off data migration"
                onChange={(e) => set('note', e.target.value)}
              />
            </div>
          </div>

          <div className="toolbar" style={{ marginTop: 12 }}>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save correction' : 'Save cost'}
            </button>
            {editing ? (
              <button type="button" className="btn subtle" onClick={cancelEdit} disabled={saving}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>

      {/* --------------------------------------------------------- history */}
      <div style={{ marginTop: 22 }}>
        {costs.length === 0 ? (
          <EmptyState title="No costs entered yet" compact>
            Add the most recent bill above. The dashboard will start including it as soon as it is
            saved.
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Provider</th>
                    <th className="num">Amount</th>
                    <th>Note</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((cost, i) => {
                    const first = i === 0 || visible[i - 1]?.month !== cost.month;
                    return (
                      <tr key={cost.id} className={first && i > 0 ? 'month-start' : undefined}>
                        <td className="cell-primary">{first ? monthLabel(cost.month, true) : ''}</td>
                        <td>{cost.provider}</td>
                        <td className="num">{formatMoney(cost.amount, cost.currency)}</td>
                        <td className="cell-sub">{cost.note ?? ''}</td>
                        <td className="row-actions">
                          <button
                            type="button"
                            className="btn sm subtle"
                            onClick={() => startEdit(cost)}
                            aria-label={`Edit ${cost.provider} for ${monthLabel(cost.month, true)}`}
                          >
                            <IconEdit size={13} />
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn sm subtle"
                            onClick={() => remove(cost)}
                            aria-label={`Remove ${cost.provider} for ${monthLabel(cost.month, true)}`}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {costs.length > ROWS_SHOWN ? (
              <button
                type="button"
                className="btn subtle"
                style={{ marginTop: 10 }}
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll ? 'Show fewer' : `Show all ${costs.length} — ${costs.length - ROWS_SHOWN} earlier`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
