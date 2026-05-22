import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ReactionStore } from '../src/reaction-store';

describe('ReactionStore', () => {
  const testDbPath = path.join('data', 'test', 'reactions-test.db');
  let store: ReactionStore;

  beforeEach(() => {
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath + '-shm'); } catch { /* ignore */ }
    store = new ReactionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath + '-shm'); } catch { /* ignore */ }
  });

  it('records an add and exposes it via listUsers / countUsers', () => {
    store.recordAdd(100, 4001, '124', 1, 12345, 'u_abc', 1700000000);
    const users = store.listUsers(100, 4001, '124');
    expect(users).toEqual([{ operatorUin: 12345, operatorUid: 'u_abc', setAt: 1700000000 }]);
    expect(store.countUsers(100, 4001, '124')).toBe(1);
  });

  it('upserts on duplicate (group, msg, emoji, operator)', () => {
    store.recordAdd(100, 4001, '124', 1, 12345, 'u_old', 1700000000);
    store.recordAdd(100, 4001, '124', 1, 12345, 'u_new', 1700000500);
    const users = store.listUsers(100, 4001, '124');
    expect(users).toHaveLength(1);
    expect(users[0]?.operatorUid).toBe('u_new');
    expect(users[0]?.setAt).toBe(1700000500);
  });

  it('removes the right row only', () => {
    store.recordAdd(100, 4001, '124', 1, 12345, 'u_a', 1700000000);
    store.recordAdd(100, 4001, '124', 1, 67890, 'u_b', 1700000100);
    store.recordRemove(100, 4001, '124', 12345);
    const users = store.listUsers(100, 4001, '124');
    expect(users).toHaveLength(1);
    expect(users[0]?.operatorUin).toBe(67890);
  });

  it('isolates by group / msg / emoji', () => {
    store.recordAdd(100, 4001, '124', 1, 1, 'u', 1);
    store.recordAdd(100, 4001, '76',  1, 1, 'u', 1);
    store.recordAdd(100, 4002, '124', 1, 1, 'u', 1);
    store.recordAdd(200, 4001, '124', 1, 1, 'u', 1);
    expect(store.countUsers(100, 4001, '124')).toBe(1);
    expect(store.countUsers(100, 4001, '76')).toBe(1);
    expect(store.countUsers(100, 4002, '124')).toBe(1);
    expect(store.countUsers(200, 4001, '124')).toBe(1);
    expect(store.countUsers(100, 4001, '999')).toBe(0);
  });

  it('paginates listUsers via limit + offset, ordering by set_at ASC', () => {
    for (let i = 0; i < 5; i++) {
      store.recordAdd(100, 4001, '124', 1, 1000 + i, `u_${i}`, 1700000000 + i);
    }
    const page1 = store.listUsers(100, 4001, '124', 2, 0);
    const page2 = store.listUsers(100, 4001, '124', 2, 2);
    expect(page1.map(u => u.operatorUin)).toEqual([1000, 1001]);
    expect(page2.map(u => u.operatorUin)).toEqual([1002, 1003]);
  });

  it('summarizeMessage groups by emoji_id', () => {
    store.recordAdd(100, 4001, '124', 1, 1, 'u1', 1);
    store.recordAdd(100, 4001, '124', 1, 2, 'u2', 2);
    store.recordAdd(100, 4001, '76',  1, 3, 'u3', 10);
    const summary = store.summarizeMessage(100, 4001).sort((a, b) => a.emojiId.localeCompare(b.emojiId));
    expect(summary).toEqual([
      { emojiId: '124', emojiType: 1, count: 2, lastSetAt: 2 },
      { emojiId: '76',  emojiType: 1, count: 1, lastSetAt: 10 },
    ]);
  });

  it('ignores incomplete records (no-op instead of throwing)', () => {
    store.recordAdd(0, 4001, '124', 1, 1, 'u', 1);            // group 0
    store.recordAdd(100, 0, '124', 1, 1, 'u', 1);             // msg 0
    store.recordAdd(100, 4001, '', 1, 1, 'u', 1);             // empty emoji
    store.recordAdd(100, 4001, '124', 1, 0, 'u', 1);          // uin 0
    expect(store.countUsers(100, 4001, '124')).toBe(0);
  });
});
