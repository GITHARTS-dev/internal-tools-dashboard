import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Verifying the access token the browser sends on every API call.
 *
 * There is no client secret anywhere in this app. Sign-in happens entirely in
 * the browser: MSAL runs the Authorization Code + PKCE flow directly against
 * Entra, and the SPA holds only an access token, never a secret capable of
 * minting one. This file is what turns that token back into a verified
 * identity server-side -- the actual access-control boundary now that nothing
 * upstream (no managed platform auth) is gating requests for us.
 *
 * Three things are checked, and all three matter:
 *   - the signature, against Entra's own published signing keys (JWKS), so a
 *     token cannot simply be invented;
 *   - the issuer, so a token from a different tenant is refused;
 *   - the audience, so a token minted for some other API cannot be replayed
 *     against this one.
 * `jose` resolves the signing key from the JWKS itself, so there is no path
 * where a symmetric or `alg: none` token is accepted -- only the asymmetric
 * keys Entra actually publishes are ever candidates.
 */

export interface AuthedUser {
  /** What goes in the audit log: the sign-in name, or the subject as a last resort. */
  actor: string;
  /** Entra's stable per-user identifier, for anything that should key on the person rather than their display name. */
  oid: string;
}

export class TokenError extends Error {}

const jwksCache = new Map<string, JWTVerifyGetKey>();

/** One remote key set per tenant, reused across requests instead of refetched each time. */
function defaultJwks(tenantId: string): JWTVerifyGetKey {
  let keySet = jwksCache.get(tenantId);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
    jwksCache.set(tenantId, keySet);
  }
  return keySet;
}

export async function verifyBearerToken(
  token: string,
  tenantId: string,
  clientId: string,
  jwks: (tenantId: string) => JWTVerifyGetKey = defaultJwks,
): Promise<AuthedUser> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks(tenantId), {
      issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      audience: `api://${clientId}`,
      algorithms: ['RS256'],
    }));
  } catch (error) {
    throw new TokenError(error instanceof Error ? error.message : 'Token verification failed');
  }

  const actor =
    typeof payload['preferred_username'] === 'string'
      ? payload['preferred_username']
      : typeof payload['upn'] === 'string'
        ? payload['upn']
        : typeof payload.sub === 'string'
          ? payload.sub
          : 'unknown';
  const oid = typeof payload['oid'] === 'string' ? payload['oid'] : (payload.sub ?? 'unknown');

  return { actor, oid };
}
