import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './components/ui';
import { api } from './lib/api';
import Dashboard from './pages/Dashboard';
import Tools from './pages/Tools';
import ToolDetail from './pages/ToolDetail';
import ToolForm from './pages/ToolForm';
import Payments from './pages/Payments';
import History from './pages/History';
import Settings from './pages/Settings';

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
  [/^\/$/, 'Dashboard', 'What needs attention right now'],
  [/^\/tools\/new$/, 'Add a tool', 'Record a new subscription'],
  [/^\/tools\/[^/]+\/edit$/, 'Edit tool', 'Update this subscription'],
  [/^\/tools\/[^/]+$/, 'Tool', 'Subscription detail'],
  [/^\/tools$/, 'Tools', 'Everything we currently pay for'],
  [/^\/payments$/, 'Payments', 'The ledger of what is due and what was paid'],
  [/^\/history$/, 'History', 'Tools we no longer pay for'],
  [/^\/settings$/, 'Settings', 'Reminders, delivery and preferences'],
];

export default function App() {
  const { theme, apply } = useTheme();
  const location = useLocation();
  const [attention, setAttention] = useState<number>(0);

  // The sidebar badge is the one number people look at without clicking in,
  // so it refreshes on every navigation rather than only on first load.
  useEffect(() => {
    let cancelled = false;
    api
      .dashboard()
      .then((data) => {
        if (!cancelled) {
          setAttention(data.alerts.filter((a) => a.severity === 'critical').length);
        }
      })
      .catch(() => {
        if (!cancelled) setAttention(0);
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
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              TS
            </span>
            <span>
              <div className="brand-text">Tools &amp; Subs</div>
              <div className="brand-sub">Internal ledger</div>
            </span>
          </div>

          <nav className="nav" aria-label="Main">
            <div>
              <div className="nav-section">Overview</div>
              <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                Dashboard
                {attention > 0 ? (
                  <span className="count" title={`${attention} urgent`}>
                    {attention}
                  </span>
                ) : null}
              </NavLink>
            </div>
            <div>
              <div className="nav-section">Records</div>
              <NavLink to="/tools" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                Tools
              </NavLink>
              <NavLink to="/payments" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                Payments
              </NavLink>
              <NavLink to="/history" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                History
              </NavLink>
            </div>
            <div>
              <div className="nav-section">Admin</div>
              <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                Settings
              </NavLink>
            </div>
          </nav>

          <div style={{ marginTop: 'auto' }}>
            <div className="nav-section">Appearance</div>
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
        </aside>

        <div className="main">
          <header className="topbar">
            <div>
              <h1>{title}</h1>
              {subtitle ? <div className="subtitle">{subtitle}</div> : null}
            </div>
            {api.isDemo ? (
              <div className="topbar-meta">
                <span className="badge warning" title="Edits are kept in memory only">
                  Demo · edits reset on reload
                </span>
              </div>
            ) : null}
          </header>

          <main className="content">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/tools/new" element={<ToolForm />} />
              <Route path="/tools/:id" element={<ToolDetail />} />
              <Route path="/tools/:id/edit" element={<ToolForm />} />
              <Route path="/payments" element={<Payments />} />
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
      </div>
    </ToastProvider>
  );
}
