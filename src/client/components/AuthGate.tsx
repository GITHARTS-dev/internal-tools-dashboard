import { useEffect, useRef, useState } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { authConfigured, apiScopes, redirectError } from '../lib/msal';

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
 *
 * The redirect itself can come back carrying an error instead of a token --
 * a scope not yet propagated, a denied consent, a stale request. That is
 * shown here rather than blindly redirecting straight back into the same
 * failure, which would either loop or (before this existed) leave the page
 * blank with the real reason sitting only in the console.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { instance } = useMsal();
  const isAuthenticated = useIsAuthenticated();
  const redirecting = useRef(false);
  const [error, setError] = useState<string | null>(redirectError);

  useEffect(() => {
    if (!authConfigured || isAuthenticated || redirecting.current || error) return;
    redirecting.current = true;
    instance.loginRedirect({ scopes: apiScopes }).catch((e: unknown) => {
      redirecting.current = false;
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [instance, isAuthenticated, error]);

  if (!authConfigured || isAuthenticated) return <>{children}</>;

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24 }}>
        <div style={{ maxWidth: 480, textAlign: 'center' }}>
          <p style={{ fontWeight: 600, marginBottom: 8 }}>Sign-in didn't complete</p>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16, wordBreak: 'break-word' }}>{error}</p>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setError(null);
              redirecting.current = false;
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-secondary)' }}>
      Redirecting to sign in…
    </div>
  );
}
