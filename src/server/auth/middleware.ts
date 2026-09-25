import type { MiddlewareHandler } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import type { Env, Variables } from '../context';
import { verifyBearerToken, TokenError } from './verifyToken';

/**
 * Requires a valid access token on every `/api/*` request, with two named
 * exceptions:
 *
 *   - `/api/health` has nothing to protect and is how the deploy checklist
 *     confirms the site is up before sign-in is even wired up.
 *   - `/api/reminders/run` is the one endpoint a machine calls, with no user
 *     signed in. It carries its own shared secret (`REMINDER_TOKEN`, checked
 *     in routes/admin.ts) and would simply refuse this middleware's check
 *     forever otherwise.
 *
 * Unset `AAD_TENANT_ID` / `AAD_CLIENT_ID` -- local development, and any
 * deploy before the Entra app registration exists -- makes this inert, the
 * same pattern `REMINDER_TOKEN` already uses: open locally, required in
 * production. `DEPLOYMENT.md` is what actually turns it on.
 */
export function requireAuth(
  /** Overridable so tests can verify against a local key set instead of a real Entra tenant. */
  jwks?: (tenantId: string) => JWTVerifyGetKey,
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    if (c.req.path === '/api/health' || c.req.path === '/api/reminders/run') return next();

    const tenantId = c.env['AAD_TENANT_ID'];
    const clientId = c.env['AAD_CLIENT_ID'];
    if (!tenantId || !clientId) return next();

    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) {
      return c.json({ error: 'unauthorized', message: 'Sign in required.' }, 401);
    }

    try {
      const user = jwks
        ? await verifyBearerToken(token, tenantId, clientId, jwks)
        : await verifyBearerToken(token, tenantId, clientId);
      c.set('actor', user.actor);
      c.set('actorOid', user.oid);
      return next();
    } catch (error) {
      if (error instanceof TokenError) {
        return c.json({ error: 'unauthorized', message: 'Your sign-in has expired. Sign in again.' }, 401);
      }
      throw error;
    }
  };
}
