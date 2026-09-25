import { useEffect, useRef } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { authConfigured, apiScopes } from '../lib/msal';

/**
 * Keeps the app off-screen until someone is signed in.
 *
 * Unconfigured locally (no `VITE_AAD_CLIENT_ID` / `VITE_AAD_TENANT_ID` set),
 * this renders straight through -- the same "open until configured" rule the
 * API's own requireAuth() follows, so local development needs no ceremony.
 *
 * Configured, an unauthenticated visitor is redirected to Entra immediately,
 * before any page or API call runs -- a client-side convenience, not the real
 * boundary. The actual enforcement is the API refusing an unauthenticated
 * request either way, so a bug here fails closed, not open.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { instance } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const redirecting = useRef(false);

  useEffect(() => {
    if (!authConfigured || isAuthenticated || redirecting.current) return;
    redirecting.current = true;
    instance.loginRedirect({ scopes: apiScopes }).catch(() => {
      redirecting.current = false;
    });
  }, [instance, isAuthenticated]);

  if (!authConfigured || isAuthenticated) return <>{children}</>;

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>
      Redirecting to sign in…
    </div>
  );
}
