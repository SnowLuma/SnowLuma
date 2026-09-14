import { describe, expect, it } from 'vitest';
import {
  redactLogMessage,
  renderParamsVerbose,
  summarizeParams,
} from '../src/log-summary';

describe('summarizeParams', () => {
  it('renders null/undefined as {}', () => {
    expect(summarizeParams(null)).toBe('{}');
    expect(summarizeParams(undefined)).toBe('{}');
  });

  it('renders a top-level non-object via String() WITHOUT quotes', () => {
    // The reported change-request: a top-level primitive is NOT JSON-quoted.
    expect(summarizeParams('hello')).toBe('hello');
    expect(summarizeParams(123)).toBe('123');
  });

  it('collapses a top-level array to [len=N]', () => {
    expect(summarizeParams([1, 2, 3])).toBe('[len=3]');
  });

  it('quotes string fields, collapses nested values, truncates long strings', () => {
    expect(summarizeParams({ a: 1, b: 'x', c: { d: 1 }, e: [1, 2] }))
      .toBe('a=1 b="x" c={...} e=[len=2]');
    expect(summarizeParams({ s: 'x'.repeat(50) }))
      .toBe(`s="${'x'.repeat(40)}..."`);
  });

  it('redacts authentication fields without exposing their values', () => {
    const out = summarizeParams({
      token: 'token-value',
      Cookie: 'cookie-value',
      Authorization: 'Bearer authorization-value',
      user_password: 'password-value',
      apiKey: 'key-value',
      group_id: 12345,
    });

    expect(out).toContain('token="***"');
    expect(out).toContain('Cookie="***"');
    expect(out).toContain('Authorization="***"');
    expect(out).toContain('user_password="***"');
    expect(out).toContain('apiKey="***"');
    expect(out).toContain('group_id=12345');
    expect(out).not.toMatch(
      /token-value|cookie-value|authorization-value|password-value|key-value/,
    );
  });

  it('does not treat sensitive substrings inside ordinary keys as credentials', () => {
    expect(summarizeParams({
      retoken: 'visible',
      cookietown: 'visible',
      myauthorization: 'visible',
    })).toBe(
      'retoken="visible" cookietown="visible" myauthorization="visible"',
    );
  });

  it('caps total output and appends "..." on overflow', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 60; i++) big['key' + i] = i;
    const out = summarizeParams(big);
    expect(out.startsWith('key0=0')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('caps a single oversized first key and top-level primitive', () => {
    const oversizedKey = 'k'.repeat(300);

    const objectOut = summarizeParams({ [oversizedKey]: 'value' });
    const primitiveOut = summarizeParams('x'.repeat(300));

    expect(objectOut).toHaveLength(200);
    expect(objectOut.endsWith('...')).toBe(true);
    expect(primitiveOut).toHaveLength(200);
    expect(primitiveOut.endsWith('...')).toBe(true);
  });
});

describe('redactLogMessage', () => {
  it('redacts explicit authentication assignments without changing prose', () => {
    const out = redactLogMessage(
      'password=secret Authorization: Bearer bearer-secret cookie="cookie secret" password change required',
    );

    expect(out).toBe(
      'password=*** Authorization: *** cookie=*** password change required',
    );
  });

  it('redacts quoted object keys, Basic auth, and complete Cookie values', () => {
    const out = redactLogMessage(
      `json={"authorization":"Basic json-auth"} object={ 'api-key': 'api-secret' } Authorization: Basic header-auth Cookie=session=cookie-secret; Path=/; HttpOnly`,
    );
    const expires = redactLogMessage(
      'Cookie=session=expires-secret; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/; HttpOnly safe=visible',
    );

    expect(out).toContain('json={"authorization":***}');
    expect(out).toContain("object={ 'api-key': *** }");
    expect(out).toContain('Authorization: *** Cookie=***');
    expect(expires).toBe('Cookie=*** safe=visible');
    expect(out).not.toMatch(/json-auth|api-secret|header-auth|cookie-secret|Path=|HttpOnly/);
    expect(expires).not.toMatch(/expires-secret|Expires|21 Oct|Path=|HttpOnly/);
  });

  it('redacts complete multi-parameter Authorization values', () => {
    const out = redactLogMessage(
      'Authorization: Digest username="alice", realm="qq", response="digest-secret"\n'
        + 'authorization=AWS4-HMAC-SHA256 Credential=AKID/20260730/cn/service/aws4_request, '
        + 'SignedHeaders=host;x-date, Signature=aws-secret\n'
        + 'Authorization: Bearer bearer-secret Cookie=session=cookie-secret; Path=/',
    );

    expect(out).toBe(
      'Authorization: ***\nauthorization=***\nAuthorization: *** Cookie=***',
    );
    expect(out).not.toMatch(
      /alice|realm|digest-secret|AKID|SignedHeaders|aws-secret|bearer-secret|cookie-secret|Path=/,
    );
  });

  it('redacts camelCase authentication keys without matching larger words', () => {
    const out = redactLogMessage(
      `authToken=auth-secret idToken=id-secret clientSecret=client-secret {"userPassword":"password-secret"}`,
    );

    expect(out).toBe(
      `authToken=*** idToken=*** clientSecret=*** {"userPassword":***}`,
    );
    expect(out).not.toMatch(
      /auth-secret|id-secret|client-secret|password-secret/,
    );
    expect(redactLogMessage(
      'retoken=value cookietown=value myauthorization=value',
    )).toBe('retoken=value cookietown=value myauthorization=value');
  });

  it('redacts leading separator and numeric authentication keys without matching larger words', () => {
    expect(redactLogMessage(
      '_token=underscore-secret --password=cli-secret 2faToken=two-factor-secret retoken=visible',
    )).toBe('_token=*** --password=*** 2faToken=*** retoken=visible');
  });

  it('redacts nested assignments inside non-sensitive wrapper values', () => {
    expect(redactLogMessage(
      'params=authToken=auth-secret params=cookie="cookie-secret"',
    )).toBe('params=authToken=*** params=cookie=***');
  });

  it('redacts the entire Authorization value when it starts with a marker', () => {
    expect(redactLogMessage('Authorization: *** secret-value'))
      .toBe('Authorization: ***');
  });

  it('redacts property paths and URL query authentication values', () => {
    const out = redactLogMessage(
      'headers.authorization=Basic dXNlcjpwYXNz '
        + 'request.token=plain-token '
        + 'GET /callback?access_token=query-secret&x=1 '
        + 'url=https://host/?api_key=url-secret',
    );

    expect(out).toContain('headers.authorization=***');
    expect(out).toContain('request.token=***');
    expect(out).toContain('/callback?access_token=***&x=1');
    expect(out).toContain('https://host/?api_key=***');
    expect(out).not.toMatch(/dXNlcjpwYXNz|plain-token|query-secret|url-secret/);
  });

  it('redacts prefixed authentication keys without matching larger words', () => {
    const redacted = redactLogMessage(
      'x-api-key=api-secret user_password=password-secret '
        + 'headers.authorization=Basic auth-secret '
        + 'x-cookie="session=cookie-secret"; Path=/; HttpOnly',
    );

    expect(redacted).toContain('x-api-key=***');
    expect(redacted).toContain('user_password=***');
    expect(redacted).toContain('headers.authorization=***');
    expect(redacted).toContain('x-cookie=***');
    expect(redacted).not.toMatch(/api-secret|password-secret|auth-secret|cookie-secret|Path=|HttpOnly/);
    expect(redactLogMessage(
      'retoken=value cookietown=value myauthorization=value',
    )).toBe('retoken=value cookietown=value myauthorization=value');
  });
});

describe('renderParamsVerbose', () => {
  it('keeps authentication fields unredacted for complete TRACE diagnostics', () => {
    const out = renderParamsVerbose({
      token: 'token-value',
      Cookie: 'cookie-value',
      password: 'password-value',
      apiKey: 'key-value',
    });

    expect(out).toContain('token:"token-value"');
    expect(out).toContain('Cookie:"cookie-value"');
    expect(out).toContain('password:"password-value"');
    expect(out).toContain('apiKey:"key-value"');
    expect(out).not.toContain('"***"');
  });

  it('does not truncate TRACE values or their enclosing object', () => {
    const unicodeValue = '雪'.repeat(800);
    const out = renderParamsVerbose({ blob: unicodeValue, tail: 'complete' });

    expect(out).toContain(`blob:${JSON.stringify(unicodeValue)}`);
    expect(out).toContain('tail:"complete"');
    expect(out).not.toMatch(/…<\d+B>|\.\.\./);
  });

  it('guards against circular references', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(renderParamsVerbose(o)).toContain('"[circular]"');
  });

  it('renders shared non-cyclic references in every branch', () => {
    const shared = { value: 1 };

    expect(renderParamsVerbose({ left: shared, right: shared }))
      .toBe('{left:{value:1},right:{value:1}}');
  });

  it('renders nested structure with primitives intact', () => {
    expect(renderParamsVerbose({ a: 1, b: [true, 'x'] })).toBe('{a:1,b:[true,"x"]}');
  });
});
