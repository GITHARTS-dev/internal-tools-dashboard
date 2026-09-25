import { describe, expect, it, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { verifyBearerToken, TokenError } from '../src/server/auth/verifyToken';
import { requireAuth } from '../src/server/auth/middleware';
import { Hono } from 'hono';
import type { Env, Variables } from '../src/server/context';

/**
 * There is no client secret anywhere in this app any more, so this file is
 * what actually protects it: a token has to carry a real signature from the
 * right tenant, for the right audience, or it is refused. Everything is
 * exercised against a locally generated key pair -- these are not real Entra
 * tokens, just tokens shaped like them, signed by a key only the test knows.
 */

const TENANT = 'contoso-tenant-id';
const CLIENT = 'contoso-client-id';
const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;
const AUDIENCE = `api://${CLIENT}`;

let jwks: JWTVerifyGetKey;
let signingKey: CryptoKey;
let kid: string;

async function makeToken(overrides: Record<string, unknown> = {}, expiredBy = 0) {
  const now = Math.floor(Date.now() / 1000) - expiredBy;
  return new SignJWT({
    preferred_username: 'priya@example.com',
    oid: 'user-object-id',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(signingKey);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  signingKey = privateKey;
  const jwk = await exportJWK(publicKey);
  kid = 'test-key-1';
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwks = createLocalJWKSet({ keys: [jwk] });
});

describe('verifyBearerToken', () => {
  it('accepts a token signed by the right tenant, for the right audience', async () => {
    const token = await makeToken();
    const user = await verifyBearerToken(token, TENANT, CLIENT, () => jwks);
    expect(user).toEqual({ actor: 'priya@example.com', oid: 'user-object-id' });
  });

  it('falls back to upn, then sub, when preferred_username is absent', async () => {
    const upnToken = await makeToken({ preferred_username: undefined, upn: 'priya@contoso.onmicrosoft.com' });
    expect((await verifyBearerToken(upnToken, TENANT, CLIENT, () => jwks)).actor).toBe(
      'priya@contoso.onmicrosoft.com',
    );

    const bareToken = await new SignJWT({ oid: 'user-object-id' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('the-subject')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey);
    expect((await verifyBearerToken(bareToken, TENANT, CLIENT, () => jwks)).actor).toBe('the-subject');
  });

  it('refuses a token for a different tenant', async () => {
    const token = await new SignJWT({ preferred_username: 'x@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://login.microsoftonline.com/some-other-tenant/v2.0')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey);
    await expect(verifyBearerToken(token, TENANT, CLIENT, () => jwks)).rejects.toThrow(TokenError);
  });

  it('refuses a token minted for a different API', async () => {
    const token = await new SignJWT({ preferred_username: 'x@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setAudience('api://some-other-app')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey);
    await expect(verifyBearerToken(token, TENANT, CLIENT, () => jwks)).rejects.toThrow(TokenError);
  });

  it('refuses an expired token', async () => {
    const token = await makeToken({}, 7200); // issued 2h ago, expired 1h ago
    await expect(verifyBearerToken(token, TENANT, CLIENT, () => jwks)).rejects.toThrow(TokenError);
  });

  it('refuses a token signed by a key not in the JWKS -- not just any valid-looking signature', async () => {
    const { privateKey: otherKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ preferred_username: 'x@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherKey);
    await expect(verifyBearerToken(token, TENANT, CLIENT, () => jwks)).rejects.toThrow(TokenError);
  });

  it('refuses garbage', async () => {
    await expect(verifyBearerToken('not-a-jwt', TENANT, CLIENT, () => jwks)).rejects.toThrow(TokenError);
  });
});

/** A tiny Hono app standing in for the real one, so the middleware is exercised exactly as it runs in production. */
function testApp(env: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('/api/*', requireAuth(() => jwks));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.post('/api/reminders/run', (c) => c.json({ ok: true }));
  app.get('/api/tools', (c) => c.json({ actor: c.get('actor') ?? null, oid: c.get('actorOid') ?? null }));
  return { app, env: { DB: {} as never, ...env } };
}

describe('requireAuth middleware', () => {
  it('is inert when AAD_TENANT_ID / AAD_CLIENT_ID are unset, same as local dev today', async () => {
    const { app, env } = testApp();
    const res = await app.request('/api/tools', {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()).actor).toBeNull();
  });

  it('always lets /api/health through, configured or not', async () => {
    const { app, env } = testApp({ AAD_TENANT_ID: TENANT, AAD_CLIENT_ID: CLIENT });
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
  });

  it('always lets /api/reminders/run through -- it has its own secret check elsewhere', async () => {
    const { app, env } = testApp({ AAD_TENANT_ID: TENANT, AAD_CLIENT_ID: CLIENT });
    const res = await app.request('/api/reminders/run', { method: 'POST' }, env);
    expect(res.status).toBe(200);
  });

  it('refuses a request with no token once configured', async () => {
    const { app, env } = testApp({ AAD_TENANT_ID: TENANT, AAD_CLIENT_ID: CLIENT });
    const res = await app.request('/api/tools', {}, env);
    expect(res.status).toBe(401);
  });

  it('sets the verified actor from a real token, end to end through the app', async () => {
    const { app, env } = testApp({ AAD_TENANT_ID: TENANT, AAD_CLIENT_ID: CLIENT });
    const token = await makeToken();
    const res = await app.request('/api/tools', { headers: { authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actor: 'priya@example.com', oid: 'user-object-id' });
  });

  it('cannot be spoofed with an x-actor header -- a bad token is refused regardless', async () => {
    const { app, env } = testApp({ AAD_TENANT_ID: TENANT, AAD_CLIENT_ID: CLIENT });
    const res = await app.request(
      '/api/tools',
      { headers: { authorization: 'Bearer not-a-real-token', 'x-actor': 'someone-else@example.com' } },
      env,
    );
    expect(res.status).toBe(401);
  });
});
