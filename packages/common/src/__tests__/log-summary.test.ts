import { describe, it, expect } from 'vitest';
import { summarizeParams, renderParamsVerbose } from '../log-summary';

describe('summarizeParams', () => {
  it('returns {} for null / undefined', () => {
    expect(summarizeParams(null)).toBe('{}');
    expect(summarizeParams(undefined)).toBe('{}');
  });

  it('renders a simple object', () => {
    expect(summarizeParams({ a: 1, b: 'hello' })).toBe('a=1 b="hello"');
  });

  it('collapses nested objects to {...}', () => {
    expect(summarizeParams({ x: { deep: true } })).toBe('x={...}');
  });

  it('collapses arrays to [len=N]', () => {
    expect(summarizeParams({ arr: [1, 2, 3] })).toBe('arr=[len=3]');
  });

  it('truncates long strings to 40 chars', () => {
    const long = 'a'.repeat(100);
    const result = summarizeParams({ s: long });
    expect(result).toContain('"aaaa');
    expect(result).toContain('..."');
  });

  it('truncates total output at ~200 chars', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) obj[`key${i}`] = 'x'.repeat(20);
    const result = summarizeParams(obj);
    expect(result.length).toBeLessThanOrEqual(210); // some tolerance
    expect(result).toContain('...');
  });

  it('renders non-object primitives as a string', () => {
    expect(summarizeParams(42)).toBe('42');
    expect(summarizeParams('hello')).toBe('"hello"');
  });

  it('renders arrays as [len=N]', () => {
    expect(summarizeParams([1, 2])).toBe('[len=2]');
  });
});

describe('renderParamsVerbose', () => {
  it('renders nested structures', () => {
    const result = renderParamsVerbose({ msg: [{ type: 'text', text: 'hi' }] });
    expect(result).toContain('text');
    expect(result).toContain('hi');
  });

  it('redacts sensitive keys', () => {
    const result = renderParamsVerbose({ access_token: 'secret123', password: 'pw' });
    expect(result).not.toContain('secret123');
    expect(result).not.toContain('pw');
    expect(result).toContain('***');
  });

  it('handles circular references without crashing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = renderParamsVerbose(obj);
    expect(result).toContain('[circular]');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(500);
    const result = renderParamsVerbose({ s: long });
    expect(result).toContain('...<500B>');
  });

  it('returns null/undefined literals', () => {
    expect(renderParamsVerbose(null)).toBe('null');
    expect(renderParamsVerbose(undefined)).toBe('undefined');
  });
});
