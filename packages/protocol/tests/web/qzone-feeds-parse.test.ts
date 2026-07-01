import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapFeeds, parseQzoneCallback } from '@snowluma/protocol/web/qzone';

// Real feeds3_html_more response captured live (issue #182). Its `data` value
// is a JS object literal (unquoted keys, single-quoted strings, \xNN escapes,
// trailing `undefined`) — JSON.parse throws on it; parseQzoneCallback must not.
const SAMPLE = readFileSync(
  fileURLToPath(new URL('./fixtures/qzone-feeds-sample.jsonp', import.meta.url)),
  'utf8',
);

interface RawFeeds {
  code?: number;
  data?: { data?: unknown[]; hasmore?: number | string };
}

describe('qzone feeds JS-literal parsing (issue #182)', () => {
  it('JSON.parse chokes on the real body (regression baseline)', () => {
    const inner = SAMPLE.slice(SAMPLE.indexOf('{'), SAMPLE.lastIndexOf('}') + 1);
    expect(() => JSON.parse(inner)).toThrow();
  });

  it('parseQzoneCallback evaluates the JS-literal payload', () => {
    const data = parseQzoneCallback<RawFeeds>(SAMPLE);
    expect(data.code).toBe(0);
    expect(Array.isArray(data.data?.data)).toBe(true);
    // The array carries a trailing `undefined` hole alongside the real feed.
    expect(data.data!.data!.length).toBe(2);
    expect(data.data!.data!.some((x) => x === undefined)).toBe(true);
  });

  it('mapFeeds drops the undefined hole and normalises the feed', () => {
    const data = parseQzoneCallback(SAMPLE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = mapFeeds(data as any);
    expect(result.feeds).toHaveLength(1);
    const f = result.feeds[0]!;
    expect(f.uin).toBe(20050606);
    expect(f.nickname).toBe('官方Qzone');
    expect(f.appid).toBe(311);
    expect(f.time).toBe(1780711209);
    expect(f.key).toBe('aef23101297f236ae4f10600');
    // \xNN escapes decoded by the JS eval, html passed through verbatim.
    expect(f.html).toContain('<li class="f-single f-s-s"');
    expect(f.html).toContain('官方Qzone');
  });

  it('parses as inert data — never resolves identifiers or executes code', () => {
    // The parser has no notion of globals, member access, or calls: any such
    // token is rejected, so a tampered body cannot reach `process`/`Function`
    // etc. (the whole reason we do NOT eval this payload).
    expect(() => parseQzoneCallback('_preloadCallback({x: process})')).toThrow();
    expect(() => parseQzoneCallback('_preloadCallback({x: callback.constructor})')).toThrow();
    expect(() => parseQzoneCallback('_preloadCallback({x: (function(){return 1})()})')).toThrow();
    expect(() => parseQzoneCallback('_preloadCallback(eval("1+1"))')).toThrow();
  });

  it('does not pollute Object.prototype via a __proto__ key', () => {
    parseQzoneCallback('_preloadCallback({"__proto__":{"polluted":1},"code":0})');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).polluted).toBeUndefined();
  });

  it('decodes JS string escapes (\\xNN, \\/) literally, not as markup', () => {
    const d = parseQzoneCallback<{ s?: string }>("_preloadCallback({s:'\\x3Cb\\x3E&\\/x'})");
    expect(d.s).toBe('<b>&/x');
  });

  it('rejects a body that captures no object', () => {
    expect(() => parseQzoneCallback('_preloadCallback(42)')).toThrow('invalid feeds response');
    expect(() => parseQzoneCallback('void 0')).toThrow('invalid feeds response');
  });
});
