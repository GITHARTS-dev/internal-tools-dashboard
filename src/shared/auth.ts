/**
 * The header the browser sends its access token in, and the API reads it from.
 *
 * Not `Authorization`: Azure Static Web Apps overwrites that header on every
 * request it forwards to the managed Functions API, so a bearer token put
 * there never reaches the code that verifies it. See auth/middleware.ts.
 */
export const ACCESS_TOKEN_HEADER = 'x-access-token';
