import { PublicClientApplication, InteractionRequiredAuthError, type Configuration } from '@azure/msal-browser';

/**
 * Sign-in, entirely in the browser.
 *
 * There is no client secret anywhere in this app. This runs the
 * Authorization Code + PKCE flow directly against Entra as a public client --
 * the redirect URI is registered as a "Single-page application" in the app
 * registration, which is what tells Entra to allow the flow without a secret
 * in the first place. The API validates the resulting access token itself
 * (see src/server/auth/); nothing upstream is gating requests for us.
 *
 * `VITE_AAD_CLIENT_ID` and `VITE_AAD_TENANT_ID` are baked in at build time.
 * Neither is secret -- they are public identifiers, the same as they would be
 * visible in any network request MSAL makes -- so they are safe to set as
 * ordinary (not secret) values in the build.
 */

const clientId = import.meta.env.VITE_AAD_CLIENT_ID as string | undefined;
const tenantId = import.meta.env.VITE_AAD_TENANT_ID as string | undefined;

/** Whether sign-in is actually configured. False locally until you set the two Vite env vars. */
export const authConfigured = Boolean(clientId && tenantId);

/** The one scope this app ever asks for: permission to call its own API as the signed-in user. */
export const apiScopes = clientId ? [`api://${clientId}/access_as_user`] : [];

const config: Configuration = {
  auth: {
    clientId: clientId ?? '',
    authority: `https://login.microsoftonline.com/${tenantId ?? 'common'}`,
    redirectUri: '/',
    postLogoutRedirectUri: '/',
  },
  cache: {
    // localStorage, not the default sessionStorage: a redirect through
    // login.microsoftonline.com is a full navigation, and a tab someone
    // reopens later should not have to sign in again just because the
    // session storage that held the in-flight request state is gone.
    cacheLocation: 'localStorage',
  },
};

export const msalInstance = new PublicClientApplication(config);

let initialized: Promise<void> | null = null;

/**
 * Set when the return trip from Entra itself carried an error -- a scope that
 * was not consented to, a resource still propagating, the person cancelling.
 * AuthGate reads this to show what went wrong instead of silently retrying
 * `loginRedirect()` forever against the same failure.
 */
export let redirectError: string | null = null;

/**
 * Call once, before rendering anything that might call the API. Safe to call
 * more than once.
 *
 * `handleRedirectPromise()` is the one call in this whole flow most likely to
 * throw -- any error Entra sends back on the redirect (a bad scope, a denied
 * consent, a stale request after the tab sat open past the code's lifetime)
 * surfaces here as a rejection. This used to propagate out of this function,
 * which is the top-level `await` in main.tsx: an unhandled rejection there
 * means `createRoot(...).render(...)` never runs, and the page goes blank
 * with nothing in it and no clue why -- the failure is real, but only visible
 * in the console. It is caught here instead, so rendering always proceeds and
 * AuthGate can show the actual message.
 *
 * `navigateToLoginRequestUrl: false` -- MSAL's default (true) does a second
 * navigation after processing the redirect response, back to whatever page
 * was active when `loginRedirect()` was called, if that differs from
 * `redirectUri`. AuthGate can call `loginRedirect()` from any route (it wraps
 * the whole app, not just "/"), so that second navigation is a real
 * possibility here, not a hypothetical -- and it is one more moving part than
 * this app needs. React Router already owns "what page is this," so there is
 * nothing for MSAL to bounce back to: landing on `redirectUri` ("/") is
 * always fine.
 */
export function ensureMsalInitialized(): Promise<void> {
  if (!initialized) {
    initialized = msalInstance.initialize().then(async () => {
      try {
        await msalInstance.handleRedirectPromise({ navigateToLoginRequestUrl: false });
      } catch (error) {
        redirectError = error instanceof Error ? error.message : String(error);
      }
      const accounts = msalInstance.getAllAccounts();
      if (accounts[0]) msalInstance.setActiveAccount(accounts[0]);
    });
  }
  return initialized;
}

/**
 * Guards every place in this app that can call `loginRedirect()` or
 * `acquireTokenRedirect()` -- currently this file's own `getAccessToken()`
 * and AuthGate's initial sign-in check -- against firing more than one of
 * them at once.
 *
 * Those two call sites are genuinely independent: AuthGate decides whether to
 * kick off sign-in at all, while `getAccessToken()` is called by every API
 * request the app makes, including ones that fire from places AuthGate does
 * not control (App.tsx's own sidebar-badge effect used to be one, until it
 * was taught to wait for sign-in too). Each redirect writes its own PKCE
 * request state to browser storage; two in flight at once means the second
 * overwrites the first's, and whichever navigation actually completes comes
 * back to a state that no longer matches -- `state_mismatch`, which reads
 * from the outside as the app "coming and going" on a loop. One shared,
 * module-level lock (not a ref or a component-local variable -- React 18
 * StrictMode discards and remounts components once in development, which a
 * ref does not survive) is what makes "only the first caller redirects" true
 * across every call site, not just within one of them.
 *
 * A plain object, not an exported `let`: an imported binding is a read-only
 * view of the exporting module's variable, so another file could read
 * `redirectInFlight` but not set it. A mutable field on an exported object
 * has no such restriction.
 */
export const redirectLock = { inFlight: false };

/**
 * An access token for the API, or `null` if nobody is signed in yet.
 *
 * Tries silently first -- the common case, using the cached refresh token --
 * and only falls back to a full redirect when that is not possible (the
 * session has actually expired, or this is the very first call). The redirect
 * branch never returns: the browser navigates away.
 */
export async function getAccessToken(): Promise<string | null> {
  const account = msalInstance.getActiveAccount() ?? msalInstance.getAllAccounts()[0];
  if (!account) {
    if (!redirectLock.inFlight) {
      redirectLock.inFlight = true;
      await msalInstance.loginRedirect({ scopes: apiScopes });
    }
    return null;
  }

  try {
    const result = await msalInstance.acquireTokenSilent({ scopes: apiScopes, account });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      if (!redirectLock.inFlight) {
        redirectLock.inFlight = true;
        await msalInstance.acquireTokenRedirect({ scopes: apiScopes, account });
      }
      return null;
    }
    throw error;
  }
}
