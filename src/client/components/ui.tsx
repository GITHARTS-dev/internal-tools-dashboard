import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { formatDate, relativeDays } from '../../shared/dates';
import { formatMoney } from '../../shared/money';
import { IconCritical, IconInfo, IconWarning } from './icons';
import type { Alert, Severity, ToolStatus } from '../../shared/types';

/**
 * Status is never carried by colour alone: every badge and alert pairs its
 * colour with a distinct icon shape and a text label, which is what keeps them
 * readable for colourblind viewers, in print, and under forced-colors.
 *
 * The three shapes differ in silhouette (circle, triangle, circle with a
 * different interior), not just in colour, so severity survives greyscale.
 */

const SEVERITY_ICON: Record<Severity, typeof IconInfo> = {
  critical: IconCritical,
  warning: IconWarning,
  info: IconInfo,
};

export function Badge({
  tone = 'info',
  children,
  dot = false,
}: {
  tone?: 'good' | 'warning' | 'critical' | 'info';
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`badge ${tone}`}>
      {dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<ToolStatus, 'good' | 'warning' | 'critical' | 'info'> = {
  active: 'good',
  trial: 'warning',
  cancelled: 'info',
  expired: 'critical',
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  active: 'Active',
  trial: 'Trial',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export function StatusBadge({ status }: { status: ToolStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function StatTile({
  label,
  value,
  note,
  extra,
  critical = false,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  extra?: ReactNode;
  critical?: boolean;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${critical ? ' is-critical' : ''}`}>{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
      {extra ? <span className="stat-extra">{extra}</span> : null}
    </div>
  );
}

export function AlertRow({ alert, onOpen }: { alert: Alert; onOpen?: (alert: Alert) => void }) {
  const SeverityIcon = SEVERITY_ICON[alert.severity];
  return (
    <div
      className="alert-row"
      onClick={onOpen ? () => onOpen(alert) : undefined}
      style={onOpen ? { cursor: 'pointer' } : undefined}
    >
      <span className={`alert-icon ${alert.severity}`}>
        <SeverityIcon size={14} />
      </span>
      <div className="alert-body">
        <div className="alert-title">{alert.title}</div>
        <div className="alert-detail">{alert.detail}</div>
      </div>
      <div className="alert-meta">
        {/* The severity word is present as text, so colour is never the only cue. */}
        <Badge tone={alert.severity === 'critical' ? 'critical' : alert.severity === 'warning' ? 'warning' : 'info'}>
          {alert.severity === 'critical' ? 'Urgent' : alert.severity === 'warning' ? 'Soon' : 'Note'}
        </Badge>
        {alert.days_until !== null ? (
          <span className="alert-when">{relativeDays(alert.days_until)}</span>
        ) : null}
      </div>
    </div>
  );
}

export function AlertList({ alerts, onOpen }: { alerts: Alert[]; onOpen?: (alert: Alert) => void }) {
  if (alerts.length === 0) {
    return (
      <div className="empty">
        <span className="empty-title">Nothing needs attention</span>
        <span>No overdue payments, deadlines or renewals in the alert window.</span>
      </div>
    );
  }
  return (
    <div className="alert-list">
      {alerts.map((alert) => (
        <AlertRow key={alert.dedupe_key} alert={alert} onOpen={onOpen} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  compact = false,
}: {
  title: string;
  children?: ReactNode;
  /** For an empty panel sitting among full ones, where it is an aside. */
  compact?: boolean;
}) {
  return (
    <div className={`empty${compact ? ' compact' : ''}`}>
      <span className="empty-title">{title}</span>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'critical' | 'good';
  children: ReactNode;
}) {
  return <div className={`banner ${tone}`}>{children}</div>;
}

/** Per-currency totals rendered without inventing an exchange rate. */
export function MoneyTotals({
  totals,
  compact = false,
  fallback = '—',
}: {
  totals: Record<string, number>;
  compact?: boolean;
  fallback?: string;
}) {
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <>{fallback}</>;
  return (
    <>
      {entries.map(([currency, amount], i) => (
        <span key={currency}>
          {i > 0 ? <span style={{ color: 'var(--text-muted)' }}> + </span> : null}
          {formatMoney(amount, currency, { compact })}
        </span>
      ))}
    </>
  );
}

export function DateText({ value }: { value: string | null | undefined }) {
  return <span>{formatDate(value)}</span>;
}

// ------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

const ToastContext = createContext<(message: string, tone?: 'info' | 'error') => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 4500);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast${toast.tone === 'error' ? ' error' : ''}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 52 }} />
      ))}
    </div>
  );
}
