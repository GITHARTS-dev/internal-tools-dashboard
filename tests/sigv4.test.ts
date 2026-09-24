import { describe, expect, it } from 'vitest';
import { amzDate, signRequest } from '../src/server/aws/sigv4';

/**
 * Pinned against AWS's published SigV4 test suite ("get-vanilla" and
 * "post-x-www-form-urlencoded"), so a signing mistake fails here rather than as
 * an opaque 403 from Cost Explorer on the first real month.
 */

const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const when = new Date('2015-08-30T12:36:00Z');

describe('SigV4', () => {
  it('formats the request date the way AWS expects', () => {
    expect(amzDate(when)).toBe('20150830T123600Z');
  });

  it('matches the get-vanilla vector', async () => {
    const headers = await signRequest(
      { method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', region: 'us-east-1', service: 'service' },
      credentials,
      when,
    );
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('matches the post-x-www-form-urlencoded vector, which signs a body and a content type', async () => {
    const headers = await signRequest(
      {
        method: 'POST',
        url: 'https://example.amazonaws.com/',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Param1=value1',
        region: 'us-east-1',
        service: 'service',
      },
      credentials,
      when,
    );
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, ' +
        'Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    );
  });

  it('signs a session token when one is given', async () => {
    const headers = await signRequest(
      { method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', region: 'us-east-1', service: 'service' },
      { ...credentials, sessionToken: 'token' },
      when,
    );
    expect(headers['x-amz-security-token']).toBe('token');
    expect(headers['authorization']).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });
});
