import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Banner, Loading, useToast } from '../components/ui';
import { parseMoneyInput, toDecimalString } from '../../shared/money';
import {
  BILLING_CYCLES,
  CATEGORY_SUGGESTIONS,
  CURRENCY_SUGGESTIONS,
  TOOL_STATUSES,
} from '../../shared/schema';

/**
 * One form for both adding and editing.
 *
 * Money is typed as a decimal and converted to integer minor units here, so
 * the API only ever receives exact integers. Server-side validation errors
 * come back keyed by field and are shown against the input that caused them,
 * rather than as one opaque banner.
 */

interface FormState {
  name: string; vendor: string; category: string; status: string;
  owner_name: string; owner_email: string; department: string;
  billing_cycle: string; cost: string; currency: string;
  seats_purchased: string; seats_used: string;
  renewal_date: string; auto_renew: boolean; cancellation_notice_days: string;
  account_ref: string; billing_email: string; payment_method: string;
  vendor_url: string; started_on: string; notes: string;
  /** '' means bought SaaS; otherwise the internal product this cost belongs to. */
  internal_product_id: string;
}

const BLANK: FormState = {
  name: '', vendor: '', category: '', status: 'active',
  owner_name: '', owner_email: '', department: '',
  billing_cycle: 'monthly', cost: '', currency: 'INR',
  seats_purchased: '', seats_used: '',
  renewal_date: '', auto_renew: true, cancellation_notice_days: '0',
  account_ref: '', billing_email: '', payment_method: '',
  vendor_url: '', started_on: '', notes: '', internal_product_id: '',
};

const CYCLE_LABEL: Record<string, string> = {
  monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual',
  one_time: 'One-off purchase', custom: 'Custom / irregular',
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Active', trial: 'Trial', cancelled: 'Cancelled', expired: 'Expired',
};

export default function ToolForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();

  const existing = useAsync(() => (id ? api.tool(id) : Promise.resolve(null)), [id]);
  const options = useAsync(() => api.toolOptions(), []);
  const products = useAsync(() => api.internalProducts(), []);

  const [form, setForm] = useState<FormState>(BLANK);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const tool = existing.data?.tool;
    if (!tool) return;
    setForm({
      name: tool.name,
      vendor: tool.vendor ?? '',
      category: tool.category,
      status: tool.status,
      owner_name: tool.owner_name ?? '',
      owner_email: tool.owner_email ?? '',
      department: tool.department ?? '',
      billing_cycle: tool.billing_cycle,
      cost: toDecimalString(tool.cost_amount, tool.currency),
      currency: tool.currency,
      seats_purchased: tool.seats_purchased?.toString() ?? '',
      seats_used: tool.seats_used?.toString() ?? '',
      renewal_date: tool.renewal_date ?? '',
      auto_renew: tool.auto_renew,
      cancellation_notice_days: String(tool.cancellation_notice_days),
      account_ref: tool.account_ref ?? '',
      billing_email: tool.billing_email ?? '',
      payment_method: tool.payment_method ?? '',
      vendor_url: tool.vendor_url ?? '',
      started_on: tool.started_on ?? '',
      notes: tool.notes ?? '',
      internal_product_id: tool.internal_product_id ?? '',
    });
  }, [existing.data]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    // Clear the error as soon as the field is touched, not on next submit.
    setFieldErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setFieldErrors({});

    const payload = {
      name: form.name,
      vendor: form.vendor,
      category: form.category || 'Other',
      status: form.status,
      owner_name: form.owner_name,
      owner_email: form.owner_email,
      department: form.department,
      // '' would be stored as an empty string; null is what "unattributed" means.
      internal_product_id: form.internal_product_id || null,
      billing_cycle: form.billing_cycle,
      cost_amount: form.cost ? parseMoneyInput(form.cost, form.currency) : null,
      currency: form.currency,
      seats_purchased: form.seats_purchased,
      seats_used: form.seats_used,
      renewal_date: form.renewal_date,
      auto_renew: form.auto_renew,
      cancellation_notice_days: form.cancellation_notice_days || 0,
      account_ref: form.account_ref,
      billing_email: form.billing_email,
      payment_method: form.payment_method,
      vendor_url: form.vendor_url,
      started_on: form.started_on,
      notes: form.notes,
    };

    try {
      const result = editing && id ? await api.updateTool(id, payload) : await api.createTool(payload);
      toast(editing ? 'Changes saved.' : `${result.tool.name} added.`);
      navigate(`/tools/${result.tool.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fields);
        setFormError(
          Object.keys(err.fields).length > 0
            ? 'Some fields need fixing — see the messages below.'
            : err.message,
        );
      } else {
        setFormError('Could not save. Is the API running?');
      }
    } finally {
      setSaving(false);
    }
  }

  if (editing && existing.loading && !existing.data) return <Loading rows={3} />;

  const err = (field: string) => fieldErrors[field];

  return (
    // noValidate: field errors come from the same Zod schema the API uses and
    // render inline, rather than as a native browser tooltip that says
    // something different and blocks submission before we see it.
    <form onSubmit={submit} noValidate>
      <div className="crumb">
        <Link to="/tools">Tools</Link> / {editing ? form.name || 'Edit' : 'New tool'}
      </div>

      {formError ? <Banner tone="critical">{formError}</Banner> : null}

      <section className="card" style={{ marginTop: 12 }}>
        <div className="form-grid">
          <div className="fieldset-title">What is it</div>

          <div className="field wide">
            <label htmlFor="name">Tool name</label>
            <input
              id="name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={Boolean(err('name'))}
              placeholder="Canva Teams"
            />
            {err('name') ? <span className="error">{err('name')}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="vendor">Vendor</label>
            <input id="vendor" value={form.vendor} onChange={(e) => set('vendor', e.target.value)} placeholder="Canva" />
          </div>

          <div className="field">
            <label htmlFor="category">Category</label>
            <input
              id="category"
              list="category-options"
              value={form.category}
              onChange={(e) => set('category', e.target.value)}
              placeholder="Design"
            />
            <datalist id="category-options">
              {[...new Set([...(options.data?.categories ?? []), ...CATEGORY_SUGGESTIONS])].map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <label htmlFor="status">Status</label>
            <select id="status" value={form.status} onChange={(e) => set('status', e.target.value)}>
              {TOOL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="vendor_url">Vendor website</label>
            <input
              id="vendor_url"
              value={form.vendor_url}
              onChange={(e) => set('vendor_url', e.target.value)}
              aria-invalid={Boolean(err('vendor_url'))}
              placeholder="https://www.canva.com"
            />
            {err('vendor_url') ? <span className="error">{err('vendor_url')}</span> : null}
          </div>

          <div className="fieldset-title">Who owns it</div>

          <div className="field">
            <label htmlFor="owner_name">Owner</label>
            <input
              id="owner_name"
              value={form.owner_name}
              onChange={(e) => set('owner_name', e.target.value)}
              placeholder="Priya Nair"
            />
            <span className="help">Whoever should be chased when this needs a decision.</span>
          </div>

          <div className="field">
            <label htmlFor="owner_email">Owner email</label>
            <input
              id="owner_email"
              type="email"
              value={form.owner_email}
              onChange={(e) => set('owner_email', e.target.value)}
              aria-invalid={Boolean(err('owner_email'))}
              placeholder="priya@example.com"
            />
            {err('owner_email') ? <span className="error">{err('owner_email')}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="department">Department</label>
            <input id="department" value={form.department} onChange={(e) => set('department', e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="internal_product_id">Part of running one of our products</label>
            <select
              id="internal_product_id"
              value={form.internal_product_id}
              onChange={(e) => set('internal_product_id', e.target.value)}
            >
              <option value="">No — this is a tool we buy</option>
              {(products.data?.products ?? []).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <span className="help">
              Hosting, domains and APIs that keep our own software running. Picking a product moves
              this cost out of “bought subscriptions” in the cost summary.
            </span>
          </div>

          <div className="fieldset-title">What it costs</div>

          <div className="field">
            <label htmlFor="cost">Cost per billing period</label>
            <input
              id="cost"
              inputMode="decimal"
              value={form.cost}
              onChange={(e) => set('cost', e.target.value)}
              aria-invalid={Boolean(err('cost_amount'))}
              placeholder="14990.00"
            />
            {err('cost_amount') ? <span className="error">{err('cost_amount')}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="currency">Currency</label>
            <input
              id="currency"
              list="currency-options"
              value={form.currency}
              onChange={(e) => set('currency', e.target.value.toUpperCase())}
              aria-invalid={Boolean(err('currency'))}
              maxLength={3}
            />
            <datalist id="currency-options">
              {CURRENCY_SUGGESTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {err('currency') ? <span className="error">{err('currency')}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="billing_cycle">Billing cycle</label>
            <select id="billing_cycle" value={form.billing_cycle} onChange={(e) => set('billing_cycle', e.target.value)}>
              {BILLING_CYCLES.map((cycle) => (
                <option key={cycle} value={cycle}>
                  {CYCLE_LABEL[cycle]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="payment_method">Paid with</label>
            <input
              id="payment_method"
              value={form.payment_method}
              onChange={(e) => set('payment_method', e.target.value)}
              placeholder="HDFC corporate card"
            />
          </div>

          <div className="field">
            <label htmlFor="billing_email">Billing email</label>
            <input
              id="billing_email"
              type="email"
              value={form.billing_email}
              onChange={(e) => set('billing_email', e.target.value)}
              aria-invalid={Boolean(err('billing_email'))}
            />
            {err('billing_email') ? <span className="error">{err('billing_email')}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="account_ref">Account reference</label>
            <input
              id="account_ref"
              value={form.account_ref}
              onChange={(e) => set('account_ref', e.target.value)}
              placeholder="CANVA-4821"
            />
          </div>

          <div className="fieldset-title">Seats</div>

          <div className="field">
            <label htmlFor="seats_purchased">Seats paid for</label>
            <input
              id="seats_purchased"
              inputMode="numeric"
              value={form.seats_purchased}
              onChange={(e) => set('seats_purchased', e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="seats_used">Seats actually in use</label>
            <input
              id="seats_used"
              inputMode="numeric"
              value={form.seats_used}
              onChange={(e) => set('seats_used', e.target.value)}
            />
            <span className="help">The gap between these two is money you can reclaim at renewal.</span>
          </div>

          <div className="fieldset-title">Dates and renewal</div>

          <div className="field">
            <label htmlFor="renewal_date">Next renewal date</label>
            <input
              id="renewal_date"
              type="date"
              value={form.renewal_date}
              onChange={(e) => set('renewal_date', e.target.value)}
              aria-invalid={Boolean(err('renewal_date'))}
            />
            {err('renewal_date') ? <span className="error">{err('renewal_date')}</span> : null}
          </div>

          <div className="field">
            <label htmlFor="started_on">Started on</label>
            <input
              id="started_on"
              type="date"
              value={form.started_on}
              onChange={(e) => set('started_on', e.target.value)}
              aria-invalid={Boolean(err('started_on'))}
            />
          </div>

          <div className="field">
            <label htmlFor="cancellation_notice_days">Cancellation notice (days)</label>
            <input
              id="cancellation_notice_days"
              inputMode="numeric"
              value={form.cancellation_notice_days}
              onChange={(e) => set('cancellation_notice_days', e.target.value)}
              aria-invalid={Boolean(err('cancellation_notice_days'))}
            />
            <span className="help">
              How much notice the vendor needs. We’ll warn you before that deadline closes.
            </span>
            {err('cancellation_notice_days') ? (
              <span className="error">{err('cancellation_notice_days')}</span>
            ) : null}
          </div>

          <div className="field">
            <label>Auto-renew</label>
            <label className="checkline">
              <input
                type="checkbox"
                checked={form.auto_renew}
                onChange={(e) => set('auto_renew', e.target.checked)}
              />
              This renews automatically unless cancelled
            </label>
          </div>

          <div className="field wide">
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>

        <div className="toolbar" style={{ marginTop: 20 }}>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add tool'}
          </button>
          <button type="button" className="btn subtle" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </section>
    </form>
  );
}
