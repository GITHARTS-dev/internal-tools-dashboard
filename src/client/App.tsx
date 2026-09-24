import { useCallback, useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './components/ui';
import { formatDate } from '../shared/dates';
import { api } from './lib/api';
import Dashboard from './pages/Dashboard';
import Tools from './pages/Tools';
import ToolDetail from './pages/ToolDetail';
import ToolForm from './pages/ToolForm';
import History from './pages/History';
import Settings from './pages/Settings';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import {
  IconDashboard,
  IconHistory,
  IconProducts,
  IconSettings,
  IconTools,
} from './components/icons';

function useTheme() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    try {
      const stored = localStorage.getItem('theme');
      return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
      return 'system';
    }
  });

  const apply = useCallback((next: 'system' | 'light' | 'dark') => {
    setTheme(next);
    try {
      if (next === 'system') {
        localStorage.removeItem('theme');
        document.documentElement.removeAttribute('data-theme');
      } else {
        localStorage.setItem('theme', next);
        document.documentElement.setAttribute('data-theme', next);
      }
    } catch {
      // Theme still applies for this session even if storage is unavailable.
    }
  }, []);

  return { theme, apply };
}

const TITLES: Array<[RegExp, string, string]> = [
  [/^\/$/, 'Dashboard', 'What needs attention, and what it costs'],
  [/^\/tools\/new$/, 'Add a tool', 'Record a new subscription'],
  [/^\/tools\/[^/]+\/edit$/, 'Edit tool', 'Update this subscription'],
  [/^\/tools\/[^/]+$/, 'Tool', 'Subscription detail'],
  [/^\/tools$/, 'Tools', 'Everything we currently pay for'],
  [/^\/products\/[^/]+$/, 'Product', 'What it costs to run'],
  [/^\/products$/, 'Our products', 'What our own software costs to run'],
  [/^\/history$/, 'History', 'Tools we no longer pay for'],
  [/^\/settings$/, 'Settings', 'Reminders, delivery and preferences'],
];

export default function App() {
  const { theme, apply } = useTheme();
  const location = useLocation();
  const [attention, setAttention] = useState<number>(0);
  const [asAt, setAsAt] = useState<string>('');

  // The sidebar badge is the one number people look at without clicking in,
  // so it refreshes on every navigation rather than only on first load.
  useEffect(() => {
    let cancelled = false;
    api
      .dashboard()
      .then((data) => {
        if (!cancelled) {
          setAttention(data.alerts.filter((a) => a.severity === 'critical').length);
          setAsAt(data.today);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAttention(0);
          setAsAt('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const [title, subtitle] = (TITLES.find(([pattern]) => pattern.test(location.pathname)) ?? [
    null,
    'Tools & Subscriptions',
    '',
  ]).slice(1) as [string, string];

  return (
    <ToastProvider>
      <div className="aurora" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            {/* Both marks ship; CSS shows the one that suits the surface. */}
            <img className="brand-logo on-light" src="/harts-logo-on-light.png" alt="HARTS" width={109} height={26} />
            <img className="brand-logo on-dark" src="/harts-logo-on-dark.png" alt="HARTS" width={109} height={26} />
            <div className="brand-sub">Tools &amp;<br />subscriptions</div>
          </div>

          <nav className="nav" aria-label="Main">
            <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <IconDashboard />
              Dashboard
              {attention > 0 ? (
                <span className="count" title={`${attention} urgent`}>
                  {attention}
                </span>
              ) : null}
            </NavLink>
            <NavLink to="/tools" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <IconTools />
              Tools
            </NavLink>
            <NavLink to="/products" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <IconProducts />
              Our products
            </NavLink>
            <NavLink to="/history" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <IconHistory />
              History
            </NavLink>
            <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <IconSettings />
              Settings
            </NavLink>
          </nav>

          <div className="topbar-meta">
            <div className="seg" role="group" aria-label="Colour theme">
              {(['system', 'light', 'dark'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={theme === option ? 'active' : ''}
                  onClick={() => apply(option)}
                >
                  {option === 'system' ? 'Auto' : option === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
        </header>

        <main className="content">
          <div className="pagehead">
            <div>
              <h1>{title}</h1>
              {subtitle ? <div className="subtitle">{subtitle}</div> : null}
            </div>
            <div className="pagehead-meta">
              {api.isDemo ? (
                <span className="badge warning" title="Edits are kept in memory only">
                  Demo · edits reset on reload
                </span>
              ) : null}
              {asAt ? <span className="as-at">As at {formatDate(asAt)}</span> : null}
            </div>
          </div>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            {/* The cost summary was folded into the dashboard; keep old links working. */}
            <Route path="/summary" element={<Navigate to="/" replace />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/:id" element={<ProductDetail />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/tools/new" element={<ToolForm />} />
            <Route path="/tools/:id" element={<ToolDetail />} />
            <Route path="/tools/:id/edit" element={<ToolForm />} />
            {/* The payments page was retired; a tool's own page still shows its payments. */}
            <Route path="/payments" element={<Navigate to="/tools" replace />} />
            <Route path="/history" element={<History />} />
            <Route path="/settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <div className="card">
                  <div className="empty">
                    <span className="empty-title">Page not found</span>
                    <span>That link does not match any screen in this app.</span>
                  </div>
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  );
}
