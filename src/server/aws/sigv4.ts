/**
 * AWS Signature Version 4, for the one AWS call this app makes.
 *
 * Hand-rolled on Web Crypto rather than pulling in the AWS SDK: the whole API
 * ships as a single Azure Function bundle, and the SDK would add megabytes to
 * sign one POST a month. The algorithm is fixed and small, and the test pins it
 * against AWS's own published test vector, so a mistake here fails `npm test`
 * rather than a request.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Only set for temporary credentials. */
  sessionToken?: string;
}

export interface SignableRequest {
  method: string;
  url: string;
  /** Header names are matched case-insensitively. `host` is added from the URL. */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/** '2015-08-30T12:36:00.000Z' -> '20150830T123600Z' */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Returns the headers to send: the caller's own, plus `host`, `x-amz-date`,
 * the session token when there is one, and `authorization`.
 */
export async function signRequest(
  request: SignableRequest,
  credentials: AwsCredentials,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  headers['host'] = url.host;
  headers['x-amz-date'] = stamp;
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    request.method.toUpperCase(),
    url.pathname || '/',
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(request.body),
  ].join('\n');

  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), day);
  const kRegion = await hmac(kDate, request.region);
  const kService = await hmac(kRegion, request.service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
