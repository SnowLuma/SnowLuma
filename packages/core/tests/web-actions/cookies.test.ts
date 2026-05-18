import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '../../src/bridge/proto/proton/oidb';
import type {
  OidbClientKeyResp,
  OidbGetPskeyResp,
} from '../../src/bridge/proto/proton/oidb-action';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// — the plugin substitutes them at the call site with the inlined codec,
// so mocking them on the module object is a no-op. We mock `runOidb`
// (non-generic, untouched by proton) to return real proton-encoded bytes
// that the production-side codec then decodes.
vi.mock('../../src/bridge/bridge-oidb', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge/bridge-oidb')>(
    '../../src/bridge/bridge-oidb',
  );
  return {
    ...actual,
    runOidb: vi.fn(async () => new Uint8Array()),
    makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  };
});

// Mock the actual HTTP cookie fetch.
vi.mock('../../src/bridge/web/request-util', () => ({
  RequestUtil: {
    HttpsGetCookies: vi.fn(async () => ({}) as Record<string, string>),
  },
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import { RequestUtil } from '../../src/bridge/web/request-util';
import {
  forceFetchClientKey,
  getPSkey,
  getCookies,
  getSKey,
  getBknFromSKey,
  getCookiesStr,
  getCsrfToken,
  getCredentials,
} from '../../src/bridge/web-actions/cookies';

const bridge = { identity: { uin: '10001' } } as any;

function resetOidbMocks() {
  vi.mocked(oidb.runOidb).mockReset();
  vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
  vi.mocked(oidb.makeOidbEnvelope).mockClear();
}

// Bake the encoded OidbBase<X> bytes a test wants `runOidb` to return.
// Keeping these inline as `protobuf_encode<OidbBase<...>>({body: ...})`
// — proton substitutes them with the inlined codec at this file's
// transform time, just like for production code.

describe('cookies — forceFetchClientKey', () => {
  beforeEach(() => { resetOidbMocks(); });

  it('returns clientKey + keyIndex + expireTime from the OIDB response', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({
        body: { clientKey: 'ck-xyz', keyIndex: 42, expireTime: 3600 } as any,
      }),
    );
    const out = await forceFetchClientKey(bridge);
    expect(out).toEqual({ clientKey: 'ck-xyz', keyIndex: '42', expireTime: '3600' });
  });

  it('falls back to default keyIndex/expireTime when the response omits them', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck' } as any }),
    );
    const out = await forceFetchClientKey(bridge);
    expect(out).toEqual({ clientKey: 'ck', keyIndex: '19', expireTime: '1800' });
  });
});

describe('cookies — getPSkey', () => {
  beforeEach(() => { resetOidbMocks(); });

  it('folds pskeyItems into a domain → pskey Map', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGetPskeyResp>>({
        body: {
          pskeyItems: [
            { domain: 'qun.qq.com', pskey: 'psk-a' },
            { domain: 'qzone.qq.com', pskey: 'psk-b' },
            { domain: 'corrupt', pskey: '' },
          ],
        } as any,
      }),
    );
    const { domainPskeyMap } = await getPSkey(bridge, ['qun.qq.com', 'qzone.qq.com']);
    expect(domainPskeyMap.get('qun.qq.com')).toBe('psk-a');
    expect(domainPskeyMap.get('qzone.qq.com')).toBe('psk-b');
    expect(domainPskeyMap.has('corrupt')).toBe(false);  // empty pskey skipped
  });
});

describe('cookies — getCookies', () => {
  beforeEach(() => {
    resetOidbMocks();
    vi.mocked(RequestUtil.HttpsGetCookies).mockReset();
  });

  it('builds the ptlogin2 jump URL with the right query params', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({
        body: { clientKey: 'ck', keyIndex: 19 } as any,
      }),
    );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({
      p_skey: 'psk',
      skey: 'sk',
    });

    const out = await getCookies(bridge, 'qun.qq.com');
    expect(out).toEqual({ p_skey: 'psk', skey: 'sk' });

    const url = vi.mocked(RequestUtil.HttpsGetCookies).mock.calls[0]![0];
    expect(url).toContain('ssl.ptlogin2.qq.com/jump');
    expect(url).toContain('clientuin=10001');
    expect(url).toContain('clientkey=ck');
    expect(url).toContain('keyindex=19');
  });

  it('falls back to getPSkey when p_skey is missing in the cookie response', async () => {
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(
        protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
      )
      .mockResolvedValueOnce(
        protobuf_encode<OidbBase<OidbGetPskeyResp>>({
          body: { pskeyItems: [{ domain: 'qun.qq.com', pskey: 'psk-from-oidb' }] } as any,
        }),
      );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({});

    const out = await getCookies(bridge, 'qun.qq.com');
    expect(out['p_skey']).toBe('psk-from-oidb');
  });

  it('returns whatever cookies it got if getPSkey fallback throws', async () => {
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(
        protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
      )
      .mockRejectedValueOnce(new Error('pskey unavailable'));
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({ skey: 'sk' });

    const out = await getCookies(bridge, 'qun.qq.com');
    expect(out).toEqual({ skey: 'sk' });  // no p_skey, but no throw
  });
});

describe('cookies — getSKey', () => {
  beforeEach(() => {
    resetOidbMocks();
    vi.mocked(RequestUtil.HttpsGetCookies).mockReset();
  });

  it('returns skey from the qzone-targeted ptlogin2 jump', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
    );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({ skey: 'the-skey' });
    expect(await getSKey(bridge)).toBe('the-skey');
  });

  it('throws when clientKey comes back empty', async () => {
    // Empty clientKey is the proto3 default; omit so it decodes back to ''.
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: {} }),
    );
    await expect(getSKey(bridge)).rejects.toThrow(/clientKey is empty/);
  });

  it('throws when the jump response omits skey', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
    );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({});
    await expect(getSKey(bridge)).rejects.toThrow(/SKey is Empty/);
  });
});

describe('cookies — pure helpers', () => {
  beforeEach(() => { resetOidbMocks(); });

  it('getBknFromSKey: deterministic djb2 truncated to 31 bits', () => {
    // Two calls on the same input → same number; different input → different.
    const a = getBknFromSKey('hello');
    const b = getBknFromSKey('hello');
    const c = getBknFromSKey('world');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(2147483647);
  });

  it('getCookiesStr: joins cookies with "; "', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
    );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({ p_skey: 'p', skey: 's' });
    const out = await getCookiesStr(bridge, 'qun.qq.com');
    expect(out).toBe('p_skey=p; skey=s');
  });

  it('getCsrfToken: combines getSKey + getBknFromSKey', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
    );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({ skey: 'abc' });
    const csrf = await getCsrfToken(bridge);
    expect(csrf).toBe(getBknFromSKey('abc'));
  });

  it('getCredentials: returns { cookies, token, csrf_token } with bkn(p_skey)', async () => {
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
    );
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({ p_skey: 'p', skey: 's' });

    const out = await getCredentials(bridge, 'qun.qq.com');
    expect(out.cookies).toBe('p_skey=p; skey=s');
    expect(out.token).toBe(getBknFromSKey('p'));
    expect(out.csrf_token).toBe(out.token);
  });

  it('getCredentials: token is 0 when no skey/p_skey available', async () => {
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(
        protobuf_encode<OidbBase<OidbClientKeyResp>>({ body: { clientKey: 'ck', keyIndex: 19 } as any }),
      )
      .mockRejectedValueOnce(new Error('no pskey'));
    vi.mocked(RequestUtil.HttpsGetCookies).mockResolvedValueOnce({});

    const out = await getCredentials(bridge, 'qun.qq.com');
    expect(out.token).toBe(0);
    expect(out.cookies).toBe('');
  });
});
