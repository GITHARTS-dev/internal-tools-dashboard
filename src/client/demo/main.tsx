import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from '../App';
import '../styles.css';

/**
 * Entry point for the standalone demo build.
 *
 * Two differences from the real app: a HashRouter, because a single static
 * file has no server to rewrite deep links; and an API that lives in memory,
 * swapped in by the alias in vite.demo.config.ts.
 */

try {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
} catch {
  // No stored preference available; the OS setting applies.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
