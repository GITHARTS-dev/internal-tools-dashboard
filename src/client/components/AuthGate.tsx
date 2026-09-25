import { useEffect, useState } from 'react';
import { useIsAuthenticated, useMsal } from '@azure/msal-react';
import { authConfigured, apiScopes, redirectError, redirectLock } from '../lib/msal';

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
 * `redirectLock` (lib/msal.ts) is shared with `getAccessToken()`, which is
 * the other place this app can call `loginRedirect()`/`acquireTokenRedirect()`
 * from. Two independent call sites each guarding only themselves is not the
 * same as one guard that actually stops a second redirect firing while the
 * first is still in flight -- see that file for the full story.
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
  const [error, setError] = useState<string | null>(redirectError);

  useEffect(() => {
    if (!authConfigured || isAuthenticated || redirectLock.inFlight || error) return;
    redirectLock.inFlight = true;
    instance.loginRedirect({ scopes: apiScopes }).catch((e: unknown) => {
      redirectLock.inFlight = false;
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
              redirectLock.inFlight = false;
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
