import { describe, it, expect } from 'vitest';
import { hashMessageIdInt32, GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../src/message-id';

describe('hashMessageIdInt32', () => {
  it('returns consistent hash for same inputs', () => {
    const id1 = hashMessageIdInt32(100, 12345, GROUP_MESSAGE_EVENT);
    const id2 = hashMessageIdInt32(100, 12345, GROUP_MESSAGE_EVENT);
    expect(id1).toBe(id2);
  });

  it('returns non-zero', () => {
    // The function ensures id !== 0 by setting it to 1
    const id = hashMessageIdInt32(0, 0, '');
    expect(id).not.toBe(0);
  });

  it('returns different values for different sequences', () => {
    const id1 = hashMessageIdInt32(1, 12345, GROUP_MESSAGE_EVENT);
    const id2 = hashMessageIdInt32(2, 12345, GROUP_MESSAGE_EVENT);
    expect(id1).not.toBe(id2);
  });

  it('returns different values for different sessions', () => {
    const id1 = hashMessageIdInt32(100, 11111, GROUP_MESSAGE_EVENT);
    const id2 = hashMessageIdInt32(100, 22222, GROUP_MESSAGE_EVENT);
    expect(id1).not.toBe(id2);
  });

  it('returns different values for different event names', () => {
    const id1 = hashMessageIdInt32(100, 12345, GROUP_MESSAGE_EVENT);
    const id2 = hashMessageIdInt32(100, 12345, PRIVATE_MESSAGE_EVENT);
    expect(id1).not.toBe(id2);
  });

  it('returns 32-bit integer', () => {
    const id = hashMessageIdInt32(999999, 123456789, GROUP_MESSAGE_EVENT);
    expect(id).toBeGreaterThanOrEqual(-2147483648);
    expect(id).toBeLessThanOrEqual(2147483647);
  });

  it('handles non-finite inputs gracefully', () => {
    const id1 = hashMessageIdInt32(NaN, 0, 'test');
    const id2 = hashMessageIdInt32(Infinity, 0, 'test');
    expect(typeof id1).toBe('number');
    expect(typeof id2).toBe('number');
    // Both should map to sequence=0
    expect(id1).toBe(id2);
  });
});
