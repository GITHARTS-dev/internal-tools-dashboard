import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { InternalProductWithCount } from '../lib/apiClient';
import { Badge, EmptyState, Loading, useToast } from '../components/ui';
import { IconPlus } from '../components/icons';
import ProductForm, { PRODUCT_STATUS_LABEL } from '../components/ProductForm';
import type { InternalProductStatus } from '../../shared/types';

/**
 * Our own products.
 *
 * The list is deliberately thin: a product is a bucket, and the interesting
 * number (what it costs to run) lives on its detail page and on the dashboard,
 * both computed from the tools attributed to it. Nothing about cost
 * is editable here, because nothing about cost is stored here.
 */

const STATUS_TONE: Record<InternalProductStatus, 'good' | 'warning' | 'info'> = {
  live: 'good',
  building: 'warning',
  retired: 'info',
};

export default function Products() {
  const [products, setProducts] = useState<InternalProductWithCount[] | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    api
      .internalProducts()
      .then((data) => setProducts(data.products))
      .catch(() => setProducts([]));
  }, []);

  useEffect(load, [load]);

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
          <div style={{ marginBottom: 18 }}>
            <ProductForm
              submitLabel="Add product"
              onCancel={() => setAdding(false)}
              onSubmit={async (values) => {
                await api.createInternalProduct(values);
                toast(`Added ${values.name}`);
                setAdding(false);
                load();
              }}
            />
          </div>
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
              {PRODUCT_STATUS_LABEL[product.status]}
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
