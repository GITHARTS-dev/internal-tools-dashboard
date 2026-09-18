import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAsync, useDebounced } from '../lib/hooks';
import { Banner, EmptyState, Loading, StatusBadge } from '../components/ui';
import { SeatMeter } from '../components/Charts';
import { formatMoney, annualisedCost } from '../../shared/money';
import { formatDate, daysBetween, relativeDays } from '../../shared/dates';
import type { Tool } from '../../shared/types';

type SortKey = 'name' | 'owner' | 'cost' | 'renewal' | 'category';

const CYCLE_LABEL: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  one_time: 'One-off',
  custom: 'Custom',
};

export default function Tools() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [owner, setOwner] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [sort, setSort] = useState<SortKey>('renewal');
  const [descending, setDescending] = useState(false);

  const debouncedSearch = useDebounced(search);

  const { data, error, loading } = useAsync(
    () =>
      api.tools({
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        ...(category ? { category } : {}),
        ...(owner ? { owner } : {}),
        ...(includeArchived ? { include_archived: 'true' } : {}),
      }),
    [debouncedSearch, category, owner, includeArchived],
  );

  const options = useAsync(() => api.toolOptions(), []);
  const today = new Date().toISOString().slice(0, 10);

  const sorted = useMemo(() => {
    const tools = [...(data?.tools ?? [])];
    const direction = descending ? -1 : 1;

    tools.sort((a, b) => {
      switch (sort) {
        case 'owner':
          return direction * (a.owner_name ?? '~').localeCompare(b.owner_name ?? '~');
        case 'category':
          return direction * a.category.localeCompare(b.category);
        case 'cost': {
          // Compare like with like: a monthly and an annual price are not
          // comparable until both are annualised.
          const av = annualisedCost(a.cost_amount, a.billing_cycle) ?? -1;
          const bv = annualisedCost(b.cost_amount, b.billing_cycle) ?? -1;
          return direction * (av - bv);
        }
        case 'renewal': {
          // Tools with no renewal date sort last, not first.
          const av = a.renewal_date ?? '9999-12-31';
          const bv = b.renewal_date ?? '9999-12-31';
          return direction * av.localeCompare(bv);
        }
        default:
          return direction * a.name.localeCompare(b.name);
      }
    });
    return tools;
  }, [data, sort, descending]);

  function toggleSort(key: SortKey) {
    if (sort === key) setDescending((d) => !d);
    else {
      setSort(key);
      setDescending(false);
    }
  }

  function header(key: SortKey, label: string, numeric = false) {
    return (
      <th className={`sortable${numeric ? ' num' : ''}`} onClick={() => toggleSort(key)} scope="col">
        {label}
        {sort === key ? <span aria-hidden="true"> {descending ? '↓' : '↑'}</span> : null}
      </th>
    );
  }

  return (
    <>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search name, vendor, owner or notes"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 260 }}
          aria-label="Search tools"
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {(options.data?.categories ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Filter by owner">
          <option value="">All owners</option>
          {(options.data?.owners ?? [])
            .filter((o) => o.name)
            .map((o) => (
              <option key={o.name} value={o.name ?? ''}>
                {o.name}
              </option>
            ))}
        </select>
        <label className="checkline">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Include cancelled
        </label>

        <span className="spacer" />
        <a className="btn" href="/api/export/tools.csv" download>
          Export CSV
        </a>
        <Link className="btn primary" to="/tools/new">
          Add tool
        </Link>
      </div>

      {error ? <Banner tone="critical">{error}</Banner> : null}

      <section className="card">
        <div className="card-head">
          <h2>{sorted.length} tool{sorted.length === 1 ? '' : 's'}</h2>
          <span className="hint">Costs shown per billing period</span>
        </div>

        {loading && !data ? (
          <Loading />
        ) : sorted.length === 0 ? (
          <EmptyState title="No tools match">
            {search || category || owner
              ? 'Try clearing the filters above.'
              : 'Add your first tool, or import a CSV from Settings.'}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {header('name', 'Tool')}
                  {header('owner', 'Owner')}
                  {header('category', 'Category')}
                  <th scope="col">Billing</th>
                  {header('cost', 'Cost', true)}
                  <th scope="col">Seats</th>
                  {header('renewal', 'Renews')}
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((tool: Tool) => {
                  const days = tool.renewal_date ? daysBetween(today, tool.renewal_date) : null;
                  return (
                    <tr key={tool.id} onClick={() => navigate(`/tools/${tool.id}`)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="cell-primary">{tool.name}</div>
                        {tool.vendor ? <div className="cell-sub">{tool.vendor}</div> : null}
                      </td>
                      <td>
                        {tool.owner_name ?? <span className="cell-sub">Unassigned</span>}
                        {tool.department ? <div className="cell-sub">{tool.department}</div> : null}
                      </td>
                      <td>{tool.category}</td>
                      <td>{CYCLE_LABEL[tool.billing_cycle] ?? tool.billing_cycle}</td>
                      <td className="num">
                        {tool.cost_amount === null ? (
                          <span className="cell-sub">Not recorded</span>
                        ) : (
                          formatMoney(tool.cost_amount, tool.currency)
                        )}
                      </td>
                      <td>
                        <SeatMeter used={tool.seats_used} purchased={tool.seats_purchased} />
                      </td>
                      <td>
                        {tool.renewal_date ? (
                          <>
                            <div>{formatDate(tool.renewal_date)}</div>
                            {days !== null && days >= 0 && days <= 60 ? (
                              <div className="cell-sub">{relativeDays(days)}</div>
                            ) : null}
                          </>
                        ) : (
                          <span className="cell-sub">Not set</span>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={tool.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
