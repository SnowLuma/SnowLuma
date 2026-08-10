import { describe, expect, it } from 'vitest';
import { formatGroupIdsInput, parseGroupIdsInput } from './group-message-filter-utils';

describe('group message filter input', () => {
  it('accepts comma and whitespace separated group ids', () => {
    expect(parseGroupIdsInput('985983966, 787682322\n123456789')).toEqual({
      groupIds: [985983966, 787682322, 123456789],
    });
  });

  it('deduplicates ids while preserving order', () => {
    expect(parseGroupIdsInput('985983966,787682322,985983966')).toEqual({
      groupIds: [985983966, 787682322],
    });
  });

  it('accepts an empty list', () => {
    expect(parseGroupIdsInput('  ')).toEqual({ groupIds: [] });
  });

  it('rejects invalid values', () => {
    expect(parseGroupIdsInput('abc').error).toBeDefined();
    expect(parseGroupIdsInput('0').error).toBeDefined();
    expect(parseGroupIdsInput('-1').error).toBeDefined();
    expect(parseGroupIdsInput('1.5').error).toBeDefined();
    expect(parseGroupIdsInput(String(Number.MAX_SAFE_INTEGER + 1)).error).toBeDefined();
  });

  it('formats ids for editing', () => {
    expect(formatGroupIdsInput([985983966, 787682322])).toBe('985983966, 787682322');
  });
});
