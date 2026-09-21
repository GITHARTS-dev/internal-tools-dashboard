import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Badge, EmptyState, Loading, MoneyTotals, StatusBadge, useToast } from '../components/ui';
import { IconArrowLeft } from '../components/icons';
import { annualisedCost, monthlyCost } from '../../shared/money';
import { formatDate } from '../../shared/dates';
import type { InternalProduct, InternalProductStatus, Tool } from '../../shared/types';

/**
 * One internal product and the subscriptions that make up its running cost.
 *
 * Totals stay per-currency here on purpose. This screen is the admin's working
 * view, where seeing "$45/mo + ₹2,000/mo" is more useful than one converted
 * figure; the single-currency roll-up is the cost summary's job.
 */

const STATUS_LABEL: Record<InternalProductStatus, string> = {
  live: 'Live',
  building: 'Building',
  retired: 'Retired',
};

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
  const annual: Record<string, number> = {};
  for (const tool of live) {
    const m = monthlyCost(tool.cost_amount, tool.billing_cycle);
    const a = annualisedCost(tool.cost_amount, tool.billing_cycle);
    const cur = tool.currency.toUpperCase();
    if (m) monthly[cur] = (monthly[cur] ?? 0) + m;
    if (a) annual[cur] = (annual[cur] ?? 0) + a;
  }

  return (
    <>
      <div className="card">
        <div className="crumb">
          <Link to="/products">
            <IconArrowLeft size={12} /> Our products
          </Link>
        </div>

        <div className="card-head" style={{ marginBottom: 6 }}>
          <h1>{product.name}</h1>
          <Badge tone={STATUS_TONE[product.status]} dot>
            {STATUS_LABEL[product.status]}
          </Badge>
        </div>

        {product.description ? (
          <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>{product.description}</p>
        ) : null}

        <dl className="detail-grid">
          <div className="detail-item">
            <dt>Monthly running cost</dt>
            <dd>
              <MoneyTotals totals={monthly} />
            </dd>
          </div>
          <div className="detail-item">
            <dt>Annual running cost</dt>
            <dd>
              <MoneyTotals totals={annual} />
            </dd>
          </div>
          <div className="detail-item">
            <dt>Owner</dt>
            <dd>{product.owner_name || '--'}</dd>
          </div>
          <div className="detail-item">
            <dt>Launched</dt>
            <dd>{formatDate(product.launched_on)}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>What it runs on</h2>
          <span className="hint">
            {tools.length} attributed {tools.length === 1 ? 'subscription' : 'subscriptions'}
          </span>
        </div>
        <div className="card-sub">
          Attribute a subscription to this product by editing that tool and choosing this product.
        </div>

        {tools.length === 0 ? (
          <EmptyState title="Nothing attributed yet">
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
          stop being counted against this product.
        </div>
        <button type="button" className="btn danger" onClick={remove}>
          Remove {product.name}
        </button>
      </div>
    </>
  );
}
