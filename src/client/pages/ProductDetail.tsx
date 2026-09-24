import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Badge, EmptyState, Loading, MoneyTotals, StatusBadge, useToast } from '../components/ui';
import { IconArrowLeft, IconEdit } from '../components/icons';
import MonthlyCosts from '../components/MonthlyCosts';
import ProductForm, {
  PRODUCT_STATUS_LABEL,
  valuesFromProduct,
} from '../components/ProductForm';
import { formatMoney, monthlyCost } from '../../shared/money';
import { formatDate } from '../../shared/dates';
import type { InternalProduct, InternalProductStatus, Tool } from '../../shared/types';

/**
 * One internal product: its fixed subscriptions, and what it actually cost each
 * month.
 *
 * Running cost has two parts and this page keeps them apart. The subscriptions
 * attributed to the product are fixed prices, shown per-currency here on
 * purpose: this is the admin's working view, where "$45/mo + ₹2,000/mo" is more
 * useful than one converted figure. The usage-based cloud costs are recorded per
 * month and averaged; the single-currency roll-up of both lives on the dashboard.
 *
 * Everything the edit form can set is shown here when it has a value, so what
 * you type and what you read back are the same set of facts.
 */

const STATUS_TONE: Record<InternalProductStatus, 'good' | 'warning' | 'info'> = {
  live: 'good',
  building: 'warning',
  retired: 'info',
};

export default function ProductDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [product, setProduct] = useState<InternalProduct | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const costs = useAsync(() => api.productCosts(id), [id]);

  const load = useCallback(() => {
    api
      .internalProduct(id)
      .then((data) => {
        setProduct(data.product);
        setTools(data.tools);
      })
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(load, [load]);

  async function remove() {
    const live = tools.length;
    const message =
      live > 0
        ? `Remove ${product?.name}? The ${live} ${live === 1 ? 'subscription' : 'subscriptions'} attributed to it will be kept and become unattributed.`
        : `Remove ${product?.name}?`;
    if (!confirm(message)) return;

    try {
      const result = await api.deleteInternalProduct(id);
      toast(
        result.tools_released > 0
          ? `Removed. ${result.tools_released} ${result.tools_released === 1 ? 'subscription is' : 'subscriptions are'} now unattributed.`
          : 'Removed.',
      );
      navigate('/products');
    } catch {
      toast('Could not remove that product.', 'error');
    }
  }

  if (missing) {
    return (
      <div className="card">
        <EmptyState title="No such product">
          <Link to="/products">Back to our products</Link>
        </EmptyState>
      </div>
    );
  }
  if (!product) return <Loading rows={3} />;

  const live = tools.filter((t) => t.status === 'active' || t.status === 'trial');
  const monthly: Record<string, number> = {};
  for (const tool of live) {
    const m = monthlyCost(tool.cost_amount, tool.billing_cycle);
    const cur = tool.currency.toUpperCase();
    if (m) monthly[cur] = (monthly[cur] ?? 0) + m;
  }
  const usage = costs.data?.usage;

  return (
    <>
      <div className="card">
        <div className="crumb">
          <Link to="/products">
            <IconArrowLeft size={12} /> Our products
          </Link>
        </div>

        {editing ? (
          <>
            <div className="card-head">
              <h2>Edit {product.name}</h2>
            </div>
            <ProductForm
              initial={valuesFromProduct(product)}
              submitLabel="Save changes"
              onCancel={() => setEditing(false)}
              onSubmit={async (values) => {
                const { product: saved } = await api.updateInternalProduct(id, values);
                setProduct(saved);
                setEditing(false);
                toast('Saved.');
              }}
            />
          </>
        ) : (
          <>
            <div className="card-head" style={{ marginBottom: 6 }}>
              <h1>{product.name}</h1>
              <Badge tone={STATUS_TONE[product.status]} dot>
                {PRODUCT_STATUS_LABEL[product.status]}
              </Badge>
              <button
                type="button"
                className="btn sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => setEditing(true)}
              >
                <IconEdit size={13} />
                Edit
              </button>
            </div>

            {product.description ? (
              <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
                {product.description}
              </p>
            ) : null}

            <dl className="detail-grid">
              <div className="detail-item">
                <dt>Subscriptions a month</dt>
                <dd>
                  <MoneyTotals totals={monthly} />
                  <div className="cell-sub">fixed, from attributed tools</div>
                </dd>
              </div>
              <div className="detail-item">
                <dt>Usage a month</dt>
                <dd>
                  {usage && usage.average_reported !== null && costs.data ? (
                    <>
                      {formatMoney(usage.average_reported, costs.data.reporting_currency)}
                      <div className="cell-sub">
                        average of {usage.months_counted}{' '}
                        {usage.months_counted === 1 ? 'month' : 'months'} entered
                      </div>
                    </>
                  ) : (
                    <>
                      {'\u2014'}
                      <div className="cell-sub">no recent months entered</div>
                    </>
                  )}
                </dd>
              </div>
              <div className="detail-item">
                <dt>Owner</dt>
                <dd>
                  {product.owner_name || '--'}
                  {product.owner_email ? (
                    <div className="cell-sub">
                      <a href={`mailto:${product.owner_email}`}>{product.owner_email}</a>
                    </div>
                  ) : null}
                </dd>
              </div>
              <div className="detail-item">
                <dt>Launched</dt>
                <dd>{formatDate(product.launched_on)}</dd>
              </div>
              {product.status === 'retired' ? (
                <div className="detail-item">
                  <dt>Retired</dt>
                  <dd>{formatDate(product.retired_on)}</dd>
                </div>
              ) : null}
            </dl>

            {product.notes ? (
              <div style={{ marginTop: 16 }}>
                <div className="detail-item">
                  <dt>Notes</dt>
                  <dd style={{ whiteSpace: 'pre-wrap' }}>{product.notes}</dd>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {costs.data ? (
        <MonthlyCosts
          productId={id}
          data={costs.data}
          onChanged={costs.reload}
        />
      ) : costs.error ? (
        <div className="card">
          <EmptyState title="Could not load the monthly costs" compact>
            {costs.error}
          </EmptyState>
        </div>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2>What it runs on</h2>
          <span className="hint">
            {tools.length} attributed {tools.length === 1 ? 'subscription' : 'subscriptions'}
          </span>
        </div>
        <div className="card-sub">
          The fixed subscriptions that keep it running, such as a hosting plan, a domain or
          licences. Attribute one by editing that tool and choosing this product. Bills that
          change with usage belong in Monthly costs above, not here.
        </div>

        {tools.length === 0 ? (
          <EmptyState title="Nothing attributed yet" compact>
            Open a hosting, domain or API subscription on the <Link to="/tools">Tools</Link> screen
            and set its product to {product.name}.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Status</th>
                  <th>Cycle</th>
                  <th className="num">Cost</th>
                  <th>Renews</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.id}>
                    <td>
                      <Link to={`/tools/${tool.id}`} className="cell-primary">
                        {tool.name}
                      </Link>
                      {tool.vendor ? <div className="cell-sub">{tool.vendor}</div> : null}
                    </td>
                    <td>
                      <StatusBadge status={tool.status} />
                    </td>
                    <td>{tool.billing_cycle.replace('_', ' ')}</td>
                    <td className="num">
                      <MoneyTotals
                        totals={tool.cost_amount ? { [tool.currency]: tool.cost_amount } : {}}
                      />
                    </td>
                    <td>{formatDate(tool.renewal_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Remove this product</h2>
        </div>
        <div className="card-sub">
          The subscriptions attributed to it are kept, because we still pay for them. They simply
          stop being counted against this product. A product with monthly costs recorded cannot be
          removed, because that history is the record of what it cost: set its status to Retired
          instead.
        </div>
        <button type="button" className="btn danger" onClick={remove}>
          Remove {product.name}
        </button>
      </div>
    </>
  );
}
