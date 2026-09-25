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

/** Call once, before rendering anything that might call the API. Safe to call more than once. */
export function ensureMsalInitialized(): Promise<void> {
  if (!initialized) {
    initialized = msalInstance.initialize().then(async () => {
      await msalInstance.handleRedirectPromise();
      const accounts = msalInstance.getAllAccounts();
      if (accounts[0]) msalInstance.setActiveAccount(accounts[0]);
    });
  }
  return initialized;
}

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
    await msalInstance.loginRedirect({ scopes: apiScopes });
    return null;
  }

  try {
    const result = await msalInstance.acquireTokenSilent({ scopes: apiScopes, account });
    return result.accessToken;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await msalInstance.acquireTokenRedirect({ scopes: apiScopes, account });
      return null;
    }
    throw error;
  }
}
