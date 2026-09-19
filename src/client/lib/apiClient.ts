import { ApiError } from './errors';
import type {
  Alert,
  AppSettings,
  AuditEntry,
  CategorySpend,
  DataStatus,
  KpiSummary,
  NotificationEntry,
  Payment,
  RenewalTimelineEntry,
  Tool,
  ToolDocument,
} from '../../shared/types';

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

  importCsv: (csv: string, commit: boolean) =>
    request<ImportResult>(`/import${commit ? '?commit=true' : ''}`, {
      method: 'POST',
      body: csv,
      headers: { 'content-type': 'text/csv' },
    }),
};
