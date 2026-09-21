import { useState } from 'react';
import { ApiError } from '../lib/errors';
import { useToast } from './ui';
import { INTERNAL_PRODUCT_STATUSES } from '../../shared/schema';
import type { InternalProduct, InternalProductStatus } from '../../shared/types';

/**
 * One form for adding and editing an internal product.
 *
 * It used to be two: the add form lived inline on the list page with six
 * fields, the detail page displayed eight, and there was no way to edit at all.
 * That left fields you could see but never set (launch date) and mistakes you
 * could not correct (a misspelt name, a product that had since been retired).
 * A single form means the two screens cannot drift apart again.
 */

export interface ProductFormValues {
  name: string;
  status: InternalProductStatus;
  description: string;
  owner_name: string;
  owner_email: string;
  launched_on: string;
  retired_on: string;
  notes: string;
}

export const BLANK_PRODUCT: ProductFormValues = {
  name: '',
  status: 'live',
  description: '',
  owner_name: '',
  owner_email: '',
  launched_on: '',
  retired_on: '',
  notes: '',
};

export const PRODUCT_STATUS_LABEL: Record<InternalProductStatus, string> = {
  live: 'Live',
  building: 'Building',
  retired: 'Retired',
};

export function valuesFromProduct(product: InternalProduct): ProductFormValues {
  return {
    name: product.name,
    status: product.status,
    description: product.description ?? '',
    owner_name: product.owner_name ?? '',
    owner_email: product.owner_email ?? '',
    launched_on: product.launched_on ?? '',
    retired_on: product.retired_on ?? '',
    notes: product.notes ?? '',
  };
}

export default function ProductForm({
  initial = BLANK_PRODUCT,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: ProductFormValues;
  submitLabel: string;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [values, setValues] = useState<ProductFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function set<K extends keyof ProductFormValues>(key: K, value: ProductFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    // Clear the error as soon as the field is touched, not on the next submit.
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});

    // A retirement date on a product that is not retired would be a lie the
    // rest of the app would then believe, so it is cleared rather than kept.
    const payload = values.status === 'retired' ? values : { ...values, retired_on: '' };

    try {
      await onSubmit(payload);
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        setErrors(error.fields);
      } else {
        toast(error instanceof ApiError ? error.message : 'Could not save that product.', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pf-name">Name</label>
          <input
            id="pf-name"
            value={values.name}
            autoFocus
            onChange={(e) => set('name', e.target.value)}
            aria-invalid={errors['name'] ? 'true' : undefined}
            placeholder="HARTS Timesheet"
          />
          {errors['name'] ? <span className="error">{errors['name']}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="pf-status">Status</label>
          <select
            id="pf-status"
            value={values.status}
            onChange={(e) => set('status', e.target.value as InternalProductStatus)}
          >
            {INTERNAL_PRODUCT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PRODUCT_STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="pf-owner">Owner</label>
          <input
            id="pf-owner"
            value={values.owner_name}
            onChange={(e) => set('owner_name', e.target.value)}
            placeholder="Who answers for this product"
          />
        </div>

        <div className="field">
          <label htmlFor="pf-email">Owner email</label>
          <input
            id="pf-email"
            type="email"
            value={values.owner_email}
            onChange={(e) => set('owner_email', e.target.value)}
            aria-invalid={errors['owner_email'] ? 'true' : undefined}
          />
          {errors['owner_email'] ? <span className="error">{errors['owner_email']}</span> : null}
        </div>

        <div className="field">
          <label htmlFor="pf-launched">Launched on</label>
          <input
            id="pf-launched"
            type="date"
            value={values.launched_on}
            onChange={(e) => set('launched_on', e.target.value)}
            aria-invalid={errors['launched_on'] ? 'true' : undefined}
          />
          {errors['launched_on'] ? <span className="error">{errors['launched_on']}</span> : null}
        </div>

        {/* Only meaningful once the product has actually been retired. */}
        {values.status === 'retired' ? (
          <div className="field">
            <label htmlFor="pf-retired">Retired on</label>
            <input
              id="pf-retired"
              type="date"
              value={values.retired_on}
              onChange={(e) => set('retired_on', e.target.value)}
              aria-invalid={errors['retired_on'] ? 'true' : undefined}
            />
            {errors['retired_on'] ? <span className="error">{errors['retired_on']}</span> : null}
          </div>
        ) : null}

        <div className="field wide">
          <label htmlFor="pf-desc">What it is</label>
          <input
            id="pf-desc"
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Internal time tracking for the delivery team"
          />
        </div>

        <div className="field wide">
          <label htmlFor="pf-notes">Notes</label>
          <textarea
            id="pf-notes"
            value={values.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Anything worth knowing when this comes up for review"
          />
        </div>
      </div>

      <div className="toolbar" style={{ marginTop: 14 }}>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="btn subtle" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
