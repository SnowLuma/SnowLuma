import { describe, expect, it } from 'vitest';
import { renderParamsVerbose, summarizeParams } from '../src/log-summary';

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

  it('caps total output and appends "..." on overflow', () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 60; i++) big['key' + i] = i;
    const out = summarizeParams(big);
    expect(out.startsWith('key0=0')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('renderParamsVerbose', () => {
  it('redacts token / password / secret keys at any depth', () => {
    const out = renderParamsVerbose({ token: 'abc', password: 'p', nested: { secret: 's' }, ok: 'v' });
    expect(out).toContain('token:"***"');
    expect(out).toContain('password:"***"');
    expect(out).toContain('secret:"***"');
    expect(out).toContain('ok:"v"');
  });

  it('truncates long strings with a Unicode ellipsis + byte count (not ASCII dots)', () => {
    // The reported change-request: the marker is `…<N B>` (U+2026), not `...<N B>`.
    const out = renderParamsVerbose({ blob: 'a'.repeat(500) });
    expect(out).toContain('…<500B>');
    expect(out).not.toContain('...<500B>');
  });

  it('guards against circular references', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(renderParamsVerbose(o)).toContain('"[circular]"');
  });

  it('renders nested structure with primitives intact', () => {
    expect(renderParamsVerbose({ a: 1, b: [true, 'x'] })).toBe('{a:1,b:[true,"x"]}');
  });
});
