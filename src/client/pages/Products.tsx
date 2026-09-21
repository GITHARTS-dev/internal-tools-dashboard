import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { InternalProductWithCount } from '../lib/apiClient';
import { ApiError } from '../lib/errors';
import { Badge, EmptyState, Loading, useToast } from '../components/ui';
import { IconPlus } from '../components/icons';
import { INTERNAL_PRODUCT_STATUSES } from '../../shared/schema';
import type { InternalProductStatus } from '../../shared/types';

/**
 * Our own products.
 *
 * The list is deliberately thin: a product is a bucket, and the interesting
 * number (what it costs to run) lives on its detail page and in the cost
 * summary, both computed from the tools attributed to it. Nothing about cost
 * is editable here, because nothing about cost is stored here.
 */

const STATUS_TONE: Record<InternalProductStatus, 'good' | 'warning' | 'info'> = {
  live: 'good',
  building: 'warning',
  retired: 'info',
};

const STATUS_LABEL: Record<InternalProductStatus, string> = {
  live: 'Live',
  building: 'Building',
  retired: 'Retired',
};

const BLANK = {
  name: '',
  description: '',
  status: 'live' as InternalProductStatus,
  owner_name: '',
  owner_email: '',
};

export default function Products() {
  const [products, setProducts] = useState<InternalProductWithCount[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(BLANK);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    api
      .internalProducts()
      .then((data) => setProducts(data.products))
      .catch(() => setProducts([]));
  }, []);

  useEffect(load, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      await api.createInternalProduct(draft);
      toast(`Added ${draft.name}`);
      setDraft(BLANK);
      setAdding(false);
      load();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fields);
        if (Object.keys(error.fields).length === 0) toast(error.message, 'error');
      } else {
        toast('Could not save that product.', 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!products) return <Loading rows={3} />;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Our own products</h2>
          <span className="hint">
            {products.length} {products.length === 1 ? 'product' : 'products'}
          </span>
        </div>
        <div className="card-sub">
          What it costs to keep our own products running. Attribute a hosting bill, domain or API
          subscription to a product on the tool's own screen, and it rolls up here. Subscription and
          licence costs only; staff time is not tracked.
        </div>

        {!adding ? (
          <div className="toolbar" style={{ marginBottom: products.length ? 14 : 0 }}>
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              <IconPlus size={14} />
              Add a product
            </button>
          </div>
        ) : (
          <form onSubmit={save} style={{ marginBottom: 18 }}>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="ip-name">Name</label>
                <input
                  id="ip-name"
                  value={draft.name}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  aria-invalid={errors['name'] ? 'true' : undefined}
                  placeholder="HARTS Timesheet"
                />
                {errors['name'] ? <span className="error">{errors['name']}</span> : null}
              </div>

              <div className="field">
                <label htmlFor="ip-status">Status</label>
                <select
                  id="ip-status"
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value as InternalProductStatus })
                  }
                >
                  {INTERNAL_PRODUCT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABEL[status]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="ip-owner">Owner</label>
                <input
                  id="ip-owner"
                  value={draft.owner_name}
                  onChange={(e) => setDraft({ ...draft, owner_name: e.target.value })}
                  placeholder="Who answers for this product"
                />
              </div>

              <div className="field">
                <label htmlFor="ip-email">Owner email</label>
                <input
                  id="ip-email"
                  type="email"
                  value={draft.owner_email}
                  onChange={(e) => setDraft({ ...draft, owner_email: e.target.value })}
                  aria-invalid={errors['owner_email'] ? 'true' : undefined}
                />
                {errors['owner_email'] ? (
                  <span className="error">{errors['owner_email']}</span>
                ) : null}
              </div>

              <div className="field wide">
                <label htmlFor="ip-desc">What it is</label>
                <input
                  id="ip-desc"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="Internal time tracking for the delivery team"
                />
              </div>
            </div>

            <div className="toolbar" style={{ marginTop: 14 }}>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? 'Saving…' : 'Add product'}
              </button>
              <button
                type="button"
                className="btn subtle"
                onClick={() => {
                  setAdding(false);
                  setDraft(BLANK);
                  setErrors({});
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {products.length === 0 && !adding ? (
          <EmptyState title="No internal products yet">
            Add one to see what our own software costs to run, alongside the subscriptions we buy.
          </EmptyState>
        ) : null}

        {products.map((product) => (
          <div className="product-row" key={product.id}>
            <div style={{ minWidth: 0 }}>
              <div className="product-name">
                <Link to={`/products/${product.id}`}>{product.name}</Link>
              </div>
              <div className="product-meta">
                {product.description || 'No description'}
                {product.owner_name ? ` · ${product.owner_name}` : ''}
              </div>
            </div>
            <Badge tone={STATUS_TONE[product.status]} dot>
              {STATUS_LABEL[product.status]}
            </Badge>
            <div className="product-cost">
              <div className="primary">{product.tool_count}</div>
              <div className="secondary">
                {product.tool_count === 1 ? 'subscription' : 'subscriptions'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
