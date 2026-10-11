import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSqliteCheckpoints } from '@snowluma/common/sqlite-checkpoints';
import { closeStoreWorkers, createAsyncStore, type AsyncStore } from '@snowluma/common/store-worker';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { WorkerIdentityService } from '@snowluma/protocol/worker-identity-service';
import type { MessageStore } from '@snowluma/onebot/message-store';
import type { CachedImage, MediaStore } from '@snowluma/onebot/media-store';
import type { ReactionStore } from '@snowluma/onebot/reaction-store';
import type { JsonObject } from '@snowluma/onebot/types';

let root: string;
const identities: WorkerIdentityService[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-worker-stores-')); });
afterEach(async () => {
  await Promise.all(identities.splice(0).map(identity => identity.close()));
  await closeStoreWorkers();
  await closeSqliteCheckpoints();
  fs.rmSync(root, { recursive: true, force: true });
});

const image: CachedImage = {
  file: 'a.png', url: 'https://example.invalid/a.png', imageUrl: 'https://example.invalid/a.png',
  fileSize: 42, fileName: 'a.png', subType: 0, summary: 'picture', isGroup: true, sessionId: 70001,
};
function event(id: number): JsonObject {
  return { post_type: 'message', message_type: 'group', group_id: 70001,
    user_id: 20001, time: 123456, message_id: id, message_seq: id, raw_message: `message ${id}` };
}
function messageStore(account = '10001'): AsyncStore<MessageStore> {
  return createAsyncStore<MessageStore>(account, 'message', [path.join(root, account, 'messages.db')]);
}
function identity(): WorkerIdentityService {
  const result = new WorkerIdentityService('10001', root);
  identities.push(result);
  return result;
}

describe('SQLite account worker integration', () => {
  it('serializes shared-file media/message writes and preserves history through reopen', async () => {
    const messages = messageStore();
    const media = createAsyncStore<MediaStore>('10001', 'media', [path.join(root, '10001', 'messages.db')]);
    const reactions = createAsyncStore<ReactionStore>('10001', 'reaction', [path.join(root, '10001', 'reactions.db')]);
    const accepted: Promise<unknown>[] = [];
    for (let id = 1; id <= 25; id++) {
      accepted.push(messages.storeHistoryEvent(id, true, 70001, id, 'message.group', event(id)));
      accepted.push(media.rememberImage({ ...image, file: `${id}.png`, fileName: `${id}.png` }));
      accepted.push(reactions.recordAdd(70001, id, '76', 1, 20001, 'u_player', 123456));
    }
    await Promise.all(accepted);
    expect(await messages.findEvent(25)).toMatchObject({ raw_message: 'message 25' });
    expect(await media.findImage('25.png')).toMatchObject({ file: '25.png' });
    expect(await reactions.countUsers(70001, 25, '76')).toBe(1);
    await Promise.all([messages.close(), media.close(), reactions.close()]);
    const reopened = messageStore();
    expect(await reopened.findEvent(25)).toMatchObject({ raw_message: 'message 25' });
    expect(await reopened.findLatestPersistedAuthoritativeSequence(true, 70001)).toBe(25);
  });

  it('commits accepted writes before close resolves', async () => {
    const store = messageStore();
    const writes = Array.from({ length: 25 }, (_, i) => store.storeEvent(i + 1, true, 70001, i + 1, 'message.group', event(i + 1)));
    await store.close();
    await Promise.all(writes);
    const reopened = messageStore();
    expect(await reopened.listSessionEvents(true, 70001, 100)).toHaveLength(25);
  });

  it('keeps recall tombstones effective when stale history arrives afterwards', async () => {
    const store = messageStore();
    const recalled = store.recordPrivateRecall(20001, 91, false, 123457);
    const stale = store.storeHistoryEvent(7, false, 20001, 100, 'message.private', {
      post_type: 'message', message_type: 'private', sub_type: 'friend', user_id: 20001,
      message_seq: 91, time: 123456, raw_message: 'recalled',
    }, { meta: { isGroup: false, targetId: 20001, sequence: 100, sequenceAuthoritative: true,
      clientSequence: 91, eventName: 'message.private', random: 0, timestamp: 123456, privateDirection: 'incoming' } });
    const results = await Promise.all([recalled, stale]);
    expect(results[1]).toBe(false);
    expect(await store.findEvent(7)).toBeNull();
  });

  it('lets timers and another account progress during a real SQLite lock wait', async () => {
    const store = messageStore();
    const other = messageStore('10002');
    await Promise.all([store.initialization, other.initialization]);
    const lock = new DatabaseSync(path.join(root, '10001', 'messages.db'));
    lock.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    let ticks = 0;
    let settled = false;
    const timer = setInterval(() => { ticks++; }, 10);
    const blocked = store.storeEvent(1, true, 70001, 1, 'message.group', event(1));
    const observed = blocked.then(() => { settled = true; }, error => { settled = true; throw error; });
    try {
      await other.storeEvent(2, true, 70001, 2, 'message.group', event(2));
      expect(await other.findEvent(2)).toMatchObject({ raw_message: 'message 2' });
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(settled).toBe(false);
      expect(ticks).toBeGreaterThanOrEqual(5);
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      clearInterval(timer);
      lock.exec('ROLLBACK'); lock.close();
      await observed;
    }
    expect(await store.findEvent(1)).toMatchObject({ raw_message: 'message 1' });
  });
});

describe('worker identity cache', () => {
  it('restores persisted non-friend UID mappings and rejects superseded mappings', async () => {
    const seed = new IdentityService('10001', path.join(root, '10001', 'snowluma_identity.db'));
    seed.rememberRequestIdentity({ uid: 'u_hidden', uin: 20001, nickname: 'hidden' });
    seed.close();
    const restored = identity();
    await restored.initialization;
    expect(restored.findUinByUid('u_hidden')).toBe(20001);
    expect(restored.findUidByUin(20001)).toBe('u_hidden');
    restored.rememberRequestIdentity({ uid: 'u_new', uin: 20001, nickname: 'new' });
    expect(restored.findUinByUid('u_hidden')).toBeNull();
    expect(restored.findUidByUin(20001)).toBe('u_new');
    await restored.close();
    const reopened = identity();
    await reopened.initialization;
    expect(reopened.findUidByUin(20001)).toBe('u_new');
  });

  it('preserves fresh observations received while restoring an older roster', async () => {
    const seed = new IdentityService('10001', path.join(root, '10001', 'snowluma_identity.db'));
    seed.rememberFriends([{ uin: 20001, uid: 'u_old', nickname: 'old', remark: '' }]);
    seed.close();
    const restored = identity();
    restored.rememberFriends([{ uin: 20002, uid: 'u_new', nickname: 'fresh', remark: '' }]);
    expect(restored.findFriend(20002)?.nickname).toBe('fresh');
    await restored.initialization;
    expect(restored.friends.map(friend => friend.nickname)).toEqual(['fresh']);
    await restored.close();
    const reopened = identity();
    await reopened.initialization;
    expect(reopened.friends.map(friend => friend.nickname)).toEqual(['fresh']);
  });

  it('reports persistence recovery after a transient lock without another observation', async () => {
    const restored = identity();
    await restored.initialization;
    const lock = new DatabaseSync(path.join(root, '10001', 'snowluma_identity.db'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      restored.rememberFriends([{ uin: 20001, uid: 'u_friend', nickname: 'friend', remark: '' }]);
      expect(restored.findFriend(20001)?.nickname).toBe('friend');
      await vi.waitFor(() => expect(restored.persistenceStatus.state).toBe('degraded'));
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    await vi.waitFor(() => expect(restored.persistenceStatus.state).toBe('healthy'), { timeout: 2500 });
    await restored.close();
    const reopened = identity();
    await reopened.initialization;
    expect(reopened.findFriend(20001)?.nickname).toBe('friend');
  });

  it('bounds startup observations without partially applying the refused observation', async () => {
    const restored = identity();
    for (let i = 0; i < restored.persistenceStatus.queueCapacity; i++) {
      restored.rememberRequestIdentity({ uid: `u_${i}`, uin: 20001 + i, nickname: `user ${i}` });
    }
    expect(() => restored.rememberRequestIdentity({ uid: 'u_overflow', uin: 30000 })).toThrow('queue is full');
    expect(restored.findUinByUid('u_overflow')).toBeNull();
    await restored.close();
    const reopened = identity();
    await reopened.initialization;
    expect(reopened.findUinByUid('u_255')).toBe(20256);
  });

  it('reports an unreadable identity store and cleans up after initialization fails', async () => {
    fs.writeFileSync(path.join(root, '10001'), 'not a directory');
    const unavailable = identity();
    await expect(unavailable.initialization).rejects.toThrow();
    expect(unavailable.persistenceStatus).toMatchObject({ state: 'degraded', suspended: true });
    identities.pop();
    await expect(unavailable.close()).rejects.toThrow('Identity worker close failed');
  });
});
