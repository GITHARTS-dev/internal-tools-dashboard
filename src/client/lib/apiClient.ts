import { ApiError } from './errors';
import type {
  Alert,
  AppSettings,
  AuditEntry,
  CategorySpend,
  CeoSummary,
  DataStatus,
  InternalProduct,
  KpiSummary,
  NotificationEntry,
  Payment,
  ProductCost,
  RenewalTimelineEntry,
  Tool,
  ToolDocument,
} from '../../shared/types';
import type { FxRate } from '../../shared/fx';
import type { ProductUsage } from '../../shared/productCosts';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body && typeof init.body === 'string' && !init.headers
        ? { 'content-type': 'application/json' }
        : {}),
      ...init.headers,
    },
  });

  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body from an error page is still worth surfacing.
  }

  if (!response.ok) {
    const body = (data ?? {}) as { message?: string; fields?: Record<string, string> };
    throw new ApiError(
      body.message ?? `Request failed (${response.status})`,
      response.status,
      body.fields ?? {},
    );
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});

export interface DashboardResponse {
  today: string;
  timezone: string;
  kpis: KpiSummary;
  alerts: Alert[];
  category_spend: CategorySpend[];
  renewal_timeline: RenewalTimelineEntry[];
  paid_by_month: Array<{ month: string; currency: string; amount: number }>;
  recent_activity: AuditEntry[];
}

export interface ToolDetailResponse {
  tool: Tool;
  payments: Payment[];
  audit: AuditEntry[];
  documents: ToolDocument[];
  documents_enabled: boolean;
}

export interface ImportResult {
  committed: boolean;
  summary: { total: number; created: number; updated: number; rejected: number };
  results: Array<{ row: number; name: string; action: string; message: string }>;
}

export interface ReminderRunResponse {
  today: string;
  timezone: string;
  alerts: Alert[];
  dry_run: boolean;
  alert_dispatch: {
    considered: number;
    notifiable: number;
    channels: Array<{
      channel: string;
      status: string;
      detail: string;
      new_alerts: number;
      alert_titles: string[];
    }>;
  };
  digest_dispatch: ReminderRunResponse['alert_dispatch'] | null;
}

export interface FxStatusResponse {
  status: {
    months: number;
    currencies: string[];
    earliest: string | null;
    latest: string | null;
    last_fetched_at: string | null;
  };
  reporting_currency: string;
  auto_refresh: boolean;
  currencies_in_use: string[];
}

export interface FxRefreshResponse {
  saved: number;
  from: string;
  to: string;
  currencies: string[];
  missing: string[];
  status: FxStatusResponse['status'];
}

export type InternalProductWithCount = InternalProduct & { tool_count: number };

export interface ProductCostsResponse {
  costs: ProductCost[];
  reporting_currency: string;
  usage: ProductUsage;
  /** Whether last month's cost is overdue to be entered: the reminder's own definition. */
  entry_due: boolean;
}

export const api = {
  isDemo: false,
  demoToday: null as string | null,

  /**
   * Downloads go through the API rather than a plain <a href>, so the demo
   * build -- which has no server to call -- can generate the same file in the
   * browser instead.
   */
  async downloadCsv(kind: 'tools' | 'payments' | 'template') {
    const path = kind === 'template' ? '/export/template.csv' : `/export/${kind}.csv`;
    const response = await fetch(`/api${path}`);
    if (!response.ok) throw new ApiError('Could not build that file.', response.status);

    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = kind === 'template' ? 'tools-template.csv' : `${kind}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  },

  dashboard: (date?: string) =>
    request<DashboardResponse>(`/dashboard${date ? `?date=${date}` : ''}`),

  history: () =>
    request<{ archived: Array<{ tool: Tool; lifetime_paid: { amount: number; currency: string } | null }> }>(
      '/dashboard/history',
    ),

  tools: (params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    return request<{ tools: Tool[] }>(`/tools${query ? `?${query}` : ''}`);
  },

  toolOptions: () =>
    request<{ categories: string[]; owners: Array<{ name: string | null; email: string | null }> }>(
      '/tools/options',
    ),

  tool: (id: string) => request<ToolDetailResponse>(`/tools/${id}`),
  createTool: (body: unknown) => request<{ tool: Tool }>('/tools', { method: 'POST', ...json(body) }),
  updateTool: (id: string, body: unknown) =>
    request<{ tool: Tool }>(`/tools/${id}`, { method: 'PATCH', ...json(body) }),
  archiveTool: (id: string, cancelled_on?: string) =>
    request<{ tool: Tool }>(`/tools/${id}/archive`, { method: 'POST', ...json({ cancelled_on }) }),
  restoreTool: (id: string) =>
    request<{ tool: Tool }>(`/tools/${id}/restore`, { method: 'POST', ...json({}) }),

  // Deleting moves a tool to the trash rather than removing it outright; it
  // stays there, restorable, until the retention window purges it for real.
  deleteTool: (id: string) => request<{ ok: true }>(`/tools/${id}`, { method: 'DELETE' }),
  undeleteTool: (id: string) =>
    request<{ tool: Tool }>(`/tools/${id}/undelete`, { method: 'POST', ...json({}) }),
  trash: () => request<{ tools: Tool[]; retention_days: number }>('/tools/trash'),
  purgeTool: (id: string) => request<{ ok: true }>(`/tools/trash/${id}`, { method: 'DELETE' }),

  schedulePayment: (toolId: string, body: unknown = {}) =>
    request<{ payment: Payment }>(`/tools/${toolId}/payments`, { method: 'POST', ...json(body) }),

  payments: (params: Record<string, string | string[]> = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) value.forEach((v) => query.append(key, v));
      else if (value) query.set(key, value);
    }
    const qs = query.toString();
    return request<{ payments: Payment[]; tool_names: Record<string, string> }>(
      `/payments${qs ? `?${qs}` : ''}`,
    );
  },

  markPaid: (id: string, body: unknown = {}) =>
    request<{ payment: Payment }>(`/payments/${id}/mark-paid`, { method: 'POST', ...json(body) }),
  bulkMarkPaid: (ids: string[], paid_on?: string) =>
    request<{ count: number }>('/payments/bulk-mark-paid', { method: 'POST', ...json({ ids, paid_on }) }),
  deletePayment: (id: string) => request<{ ok: true }>(`/payments/${id}`, { method: 'DELETE' }),

  settings: () =>
    request<{
      settings: AppSettings;
      features: { documents: boolean };
      channels: Array<{ name: string; configured: boolean }>;
    }>('/settings'),
  updateSettings: (body: Record<string, string>) =>
    request<{ settings: AppSettings }>('/settings', { method: 'PATCH', ...json(body) }),

  dryRun: (date?: string, digest = false) =>
    request<ReminderRunResponse>(
      `/reminders/dry-run?${new URLSearchParams({
        ...(date ? { date } : {}),
        ...(digest ? { digest: 'true' } : {}),
      })}`,
    ),
  runReminders: () => request<ReminderRunResponse>('/reminders/run', { method: 'POST' }),

  notifications: () => request<{ notifications: NotificationEntry[] }>('/notifications'),
  audit: () => request<{ audit: AuditEntry[] }>('/audit'),

  dataStatus: () => request<{ status: DataStatus; enabled: boolean }>('/data'),
  loadDemoData: () => request<{ status: DataStatus }>('/data/demo', { method: 'POST' }),
  removeDemoData: () => request<{ status: DataStatus }>('/data/demo', { method: 'DELETE' }),
  clearAllData: () => request<{ status: DataStatus }>('/data?confirm=true', { method: 'DELETE' }),

  testChannel: (name: string) =>
    request<{ result: { channel: string; status: string; detail: string } }>(
      `/channels/${name}/test`,
      { method: 'POST' },
    ),

  // ------------------------------------------------------------------ FX
  fxStatus: () => request<FxStatusResponse>('/fx/status'),
  fxRates: (from?: string, to?: string) => {
    const query = new URLSearchParams();
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const qs = query.toString();
    return request<{ rates: FxRate[] }>(`/fx/rates${qs ? `?${qs}` : ''}`);
  },
  refreshFx: (from?: string, to?: string) => {
    const query = new URLSearchParams();
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const qs = query.toString();
    return request<FxRefreshResponse>(`/fx/refresh${qs ? `?${qs}` : ''}`, { method: 'POST' });
  },
  setFxRate: (month: string, currency: string, rate: string) =>
    request<{ month: string; currency: string; rate: string }>(
      `/fx/rates/${month}/${currency}`,
      { method: 'PUT', ...json({ rate }) },
    ),

  // --------------------------------------------------- internal products
  internalProducts: () =>
    request<{ products: InternalProductWithCount[] }>('/internal-products'),
  internalProduct: (id: string) =>
    request<{ product: InternalProduct; tools: Tool[] }>(`/internal-products/${id}`),
  createInternalProduct: (body: unknown) =>
    request<{ product: InternalProduct }>('/internal-products', { method: 'POST', ...json(body) }),
  updateInternalProduct: (id: string, body: unknown) =>
    request<{ product: InternalProduct }>(`/internal-products/${id}`, {
      method: 'PATCH',
      ...json(body),
    }),
  deleteInternalProduct: (id: string) =>
    request<{ deleted: true; tools_released: number }>(`/internal-products/${id}`, {
      method: 'DELETE',
    }),

  productCosts: (productId: string) =>
    request<ProductCostsResponse>(`/internal-products/${productId}/costs`),
  recordProductCost: (
    productId: string,
    body: { month: string; provider: string; amount: number; currency: string; note: string },
  ) =>
    request<{ cost: ProductCost }>(`/internal-products/${productId}/costs`, {
      method: 'POST',
      ...json(body),
    }),
  deleteProductCost: (productId: string, costId: string) =>
    request<{ deleted: true }>(`/internal-products/${productId}/costs/${costId}`, {
      method: 'DELETE',
    }),

  ceoSummary: () => request<CeoSummary>('/ceo-summary'),

  importCsv: (csv: string, commit: boolean) =>
    request<ImportResult>(`/import${commit ? '?commit=true' : ''}`, {
      method: 'POST',
      body: csv,
      headers: { 'content-type': 'text/csv' },
    }),
};
