import { describe, it, expect } from 'vitest';
import { makeHttpClient } from '../src/client';

// Verifies the HTTP bridge: a OneBot action becomes a POST of `{ action, params }`
// to the endpoint (with Bearer auth), and the JSON envelope comes back verbatim.
// A fake fetch stands in for the network.
describe('makeHttpClient — OneBot HTTP wiring', () => {
  it('POSTs {action, params} to the endpoint and returns the parsed envelope', async () => {
    const calls: Array<{ url: string; body: any; auth?: string }> = [];
    const fakeFetch = (async (url: unknown, init: any) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body as string),
        auth: (init.headers as Record<string, string>)?.Authorization,
      });
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', accessToken: 'tok', fetch: fakeFetch });
    const env = await client.call('get_status', { x: 1 });

    expect(env.status).toBe('ok');
    expect(env.retcode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:9999/');
    expect(calls[0].body.action).toBe('get_status');
    expect(calls[0].body.params).toEqual({ x: 1 });
    expect(calls[0].auth).toBe('Bearer tok');
  });

  it('propagates a transport failure as a rejection (so the tool layer can map it)', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const client = makeHttpClient({ endpoint: 'http://127.0.0.1:9999/', fetch: fakeFetch });
    await expect(client.call('get_status', {})).rejects.toThrow();
  });
});
