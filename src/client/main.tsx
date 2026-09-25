import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { MsalProvider } from '@azure/msal-react';
import App from './App';
import { ensureMsalInitialized, msalInstance } from './lib/msal';
import './styles.css';

// Restore the viewer's theme choice before first paint so the page never
// flashes the wrong mode. Wrapped because storage throws in some private modes.
try {
  const stored = localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
} catch {
  // No stored preference available; the OS setting applies.
}

// MSAL must finish initializing -- including processing a redirect response
// coming back from Entra -- before anything tries to read an account or
// acquire a token. Rendering waits on it rather than racing it.
await ensureMsalInitialized();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MsalProvider instance={msalInstance}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MsalProvider>
  </StrictMode>,
);
