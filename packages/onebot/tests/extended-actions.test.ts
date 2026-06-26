// End-to-end OneBot action tests for the napcat-parity surface added in
// Tier 1 + Tier 2: send_packet, bot_exit, nc_*, group-todo, AI voice,
// and the rewired ignored-notifies family. We drive everything through
// the public `ApiHandler.handle()` entry point so the wiring (including
// param coercion, retcode shape) is part of what's under test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { GroupRequestInfo } from '@snowluma/protocol/qq-info';
import type { MessageMeta } from '../src/types';

function fakeMeta(overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    isGroup: true,
    targetId: 100,
    sequence: 555,
    eventName: 'group_message',
    clientSequence: 0,
    random: 0,
    timestamp: 0,
    ...overrides,
  };
}

/**
 * Build a BridgeInterface stub that throws on any method we haven't
 * pre-stubbed for the test. Same pattern as contact-actions.test.ts —
 * keeps tests honest about which surface they actually need.
 */
// Maps flat method names → [area, newMethodName] on the ApiHub under
// the #6 refactor. Auto-promotion lets tests written against the
// pre-refactor flat surface (`fetchGroupRequests: vi.fn()`) keep
// working without per-test restructure, even when the new method name
// drops the redundant `Group`/`File` prefix.
const APIS_ROUTING: Record<string, [string, string]> = {
  fetchFriendList: ['contacts', 'fetchFriendList'],
  fetchGroupList: ['contacts', 'fetchGroupList'],
  fetchGroupMemberList: ['contacts', 'fetchGroupMemberList'],
  fetchUserProfile: ['contacts', 'fetchUserProfile'],
  fetchGroupRequests: ['contacts', 'fetchGroupRequests'],
  fetchDownloadRKeys: ['contacts', 'fetchDownloadRKeys'],
  // GroupFileApi: methods drop `Group`/`File`/`Folder` suffix where
  // the area name already says it.
  deleteGroupFileFolder: ['groupFile', 'deleteFolder'],
  fetchGroupPttUrlByNode: ['groupFile', 'getPttUrl'],
  // InteractionApi: methods drop the redundant `Group` prefix.
  sendLike: ['interaction', 'sendLike'],
  setGroupReaction: ['interaction', 'setReaction'],
  // ProfileApi: a few methods rename (getProfileLike → getLike).
  setOnlineStatus: ['profile', 'setOnlineStatus'],
  setDiyOnlineStatus: ['profile', 'setDiyOnlineStatus'],
  setProfile: ['profile', 'setProfile'],
  setSelfLongNick: ['profile', 'setSelfLongNick'],
  setInputStatus: ['profile', 'setInputStatus'],
  setAvatar: ['profile', 'setAvatar'],
  setGroupAvatar: ['profile', 'setGroupAvatar'],
  fetchCustomFace: ['profile', 'fetchCustomFace'],
  getProfileLike: ['profile', 'getLike'],
  getUnidirectionalFriendList: ['profile', 'getUnidirectionalFriendList'],
  // FriendApi: handleRequest/delete/setRemark.
  setFriendRemark: ['friend', 'setRemark'],
  deleteFriend: ['friend', 'delete'],
  setFriendAddRequest: ['friend', 'handleRequest'],
  // ExtrasApi: group todo / stranger status / AI voice.
  setGroupTodo: ['extras', 'setGroupTodo'],
  completeGroupTodo: ['extras', 'completeGroupTodo'],
  cancelGroupTodo: ['extras', 'cancelGroupTodo'],
  getStrangerStatus: ['extras', 'getStrangerStatus'],
  fetchAiVoiceList: ['extras', 'fetchAiVoiceList'],
  fetchAiVoice: ['extras', 'fetchAiVoice'],
};

function fakeBridge(overrides: Record<string, any> = {}): BridgeInterface {
  const apisSynth: Record<string, Record<string, any>> = {};
  for (const [k, v] of Object.entries(overrides)) {
    const route = APIS_ROUTING[k];
    if (route) {
      const [area, newName] = route;
      if (!apisSynth[area]) apisSynth[area] = {};
      apisSynth[area][newName] = v;
    }
  }
  const merged = { ...overrides, apis: { ...apisSynth, ...(overrides.apis ?? {}) } };
  return new Proxy(merged as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed`);
    },
  });
}

/**
 * Build the minimum ApiActionContext needed for the tested actions.
 * Anything not stubbed throws on access — keeps the dependency surface
 * explicit. Only fields the tested actions read are populated.
 */
function fakeCtx(bridge: BridgeInterface, overrides: Partial<ApiActionContext> = {}): ApiActionContext {
  const base = {
    bridge,
    getMessageMeta: () => null,
    getMessage: () => null,
    getLoginInfo: () => ({ userId: 1, nickname: '' }),
    isOnline: () => true,
    canSendImage: () => true,
    canSendRecord: () => true,
    getDownloadRKeys: async () => [],
    ...overrides,
  };
  return new Proxy(base as ApiActionContext, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeCtx: '${String(prop)}' was not stubbed`);
    },
  });
}

function makeHandler(ctx: ApiActionContext): ApiHandler {
  return new ApiHandler(ctx);
}

// ─── Tier 1: send_packet / .send_packet ───

describe('extended-actions / send_packet', () => {
  it('hex-decodes data, calls Bridge.sendRawPacket, hex-encodes the response', async () => {
    const sendRawPacket: BridgeInterface['sendRawPacket'] = vi.fn(async () => ({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),
    }));
    const bridge = fakeBridge({ sendRawPacket });
    const h = makeHandler(fakeCtx(bridge));
    const res = await h.handle('send_packet', { cmd: 'Some.Cmd', data: 'cafebabe', rsp: true });
    const spy = vi.mocked(sendRawPacket);
    expect(spy).toHaveBeenCalledOnce();
    const sentBody = spy.mock.calls[0]![1];
    expect(Buffer.from(sentBody).toString('hex')).toBe('cafebabe');
    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: 'deadbeef' });
  });

  it('.send_packet shares the same handler', async () => {
    const sendRawPacket = vi.fn(async () => ({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0),
    }));
    const h = makeHandler(fakeCtx(fakeBridge({ sendRawPacket: sendRawPacket as any })));
    const res = await h.handle('.send_packet', { cmd: 'C', data: '' });
    expect(res.status).toBe('ok');
    expect(sendRawPacket).toHaveBeenCalledOnce();
  });

  it('with rsp=false returns null and ignores responseData', async () => {
    const bridge = fakeBridge({
      sendRawPacket: (async () => ({
        success: true, gotResponse: true, errorCode: 0, errorMessage: '',
        responseData: Buffer.from('00ff', 'hex'),
      })) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_packet', { cmd: 'C', data: '', rsp: false });
    expect(res).toMatchObject({ status: 'ok', data: null });
  });

  it('rejects missing cmd', async () => {
    const bridge = fakeBridge({ sendRawPacket: vi.fn() as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_packet', { cmd: '', data: '' });
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
  });

  it('rejects malformed hex', async () => {
    const sendRawPacket = vi.fn();
    const bridge = fakeBridge({ sendRawPacket: sendRawPacket as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_packet', { cmd: 'C', data: 'ZZZZ' });
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(sendRawPacket).not.toHaveBeenCalled();
  });

  it('rejects odd-length hex', async () => {
    const bridge = fakeBridge({ sendRawPacket: vi.fn() as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_packet', { cmd: 'C', data: 'abc' });
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
  });

  it('propagates wire-level failure as action_failed', async () => {
    const bridge = fakeBridge({
      sendRawPacket: (async () => ({
        success: false, gotResponse: false, errorCode: -1, errorMessage: 'no sender', responseData: null,
      })) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_packet', { cmd: 'C', data: '' });
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'no sender' });
  });
});

// ─── Tier 1: bot_exit ───

describe('extended-actions / bot_exit', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as any);
  });
  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it('returns ok immediately, then exits on the deferred timer', async () => {
    const h = makeHandler(fakeCtx(fakeBridge()));
    const res = await h.handle('bot_exit', {});
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
    expect(exitSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// ─── History: message_id is a signed int32 hash and is frequently NEGATIVE ───
// Regression: get_{group,friend}_msg_history declared message_id with a
// `{min:0}` validator, so a real (negative) anchor message_id was rejected at
// param-validation time (retcode 1400) before the handler ran — see the
// `message_id=-497311472 ⇒ failed (0ms)` report.

describe('extended-actions / history accepts negative message_id', () => {
  it('get_group_msg_history forwards a negative anchor to the handler', async () => {
    const getGroupMsgHistory = vi.fn(async () => [{ message_id: -1, message_type: 'group' }]);
    const ctx = fakeCtx(fakeBridge(), { getGroupMsgHistory } as any);
    const res = await makeHandler(ctx).handle('get_group_msg_history', {
      group_id: 100, message_id: -497311472, count: 100,
    });
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
    expect(getGroupMsgHistory).toHaveBeenCalledWith(100, -497311472, 100);
  });

  it('get_friend_msg_history forwards a negative anchor to the handler', async () => {
    const getFriendMsgHistory = vi.fn(async () => [{ message_id: -1, message_type: 'private' }]);
    const ctx = fakeCtx(fakeBridge(), { getFriendMsgHistory } as any);
    const res = await makeHandler(ctx).handle('get_friend_msg_history', {
      user_id: 12345, message_id: -670862300, count: 100,
    });
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
    expect(getFriendMsgHistory).toHaveBeenCalledWith(12345, -670862300, 100);
  });

  it('still defaults an absent message_id to 0 (fetch-latest semantics)', async () => {
    const getGroupMsgHistory = vi.fn(async () => []);
    const ctx = fakeCtx(fakeBridge(), { getGroupMsgHistory } as any);
    const res = await makeHandler(ctx).handle('get_group_msg_history', { group_id: 100 });
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
    expect(getGroupMsgHistory).toHaveBeenCalledWith(100, 0, 20);
  });
});

// ─── Tier 1: nc_get_packet_status / nc_get_rkey ───

describe('extended-actions / nc_get_packet_status', () => {
  it('reports healthy with no dependency on bridge', async () => {
    const h = makeHandler(fakeCtx(fakeBridge()));
    const res = await h.handle('nc_get_packet_status', {});
    expect(res).toEqual({ status: 'ok', retcode: 0, data: null });
  });
});

describe('extended-actions / nc_get_rkey', () => {
  it('reuses the same data the get_rkey handler returns', async () => {
    const ctx = fakeCtx(fakeBridge(), {
      getDownloadRKeys: async () => [{ rkey: 'abc', type: 1, ttl: 60, create_time: 1 }],
    });
    const h = makeHandler(ctx);
    const a = await h.handle('get_rkey', {});
    const b = await h.handle('nc_get_rkey', {});
    expect(b).toEqual(a);
    expect(b.data).toEqual([{ rkey: 'abc', type: 1, ttl: 60, create_time: 1 }]);
  });
});

// ─── Tier 1: group-request ignored / shut list / ignore-add ───

function fakeFilteredRequest(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
  return {
    groupId: 999,
    groupName: 'g',
    targetUid: 'u_t',
    targetUin: 5555,
    targetName: 'target',
    invitorUid: 'u_i',
    invitorUin: 7777,
    invitorName: 'inviter',
    operatorUid: 'u_o',
    operatorUin: 8888,
    operatorName: 'op',
    sequence: 42,
    state: 1,
    eventType: 7,
    comment: 'pls',
    filtered: true,
    ...overrides,
  };
}

describe('extended-actions / get_group_ignored_notifies', () => {
  it('maps filtered fetchGroupRequests(true) into the napcat shape', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) =>
      filtered ? [fakeFilteredRequest()] : []
    );
    const bridge = fakeBridge({ fetchGroupRequests: fetchGroupRequests as any });
    const h = makeHandler(fakeCtx(bridge));
    const res = await h.handle('get_group_ignored_notifies', {});
    expect(fetchGroupRequests).toHaveBeenCalledWith(true);
    expect(res.status).toBe('ok');
    expect(res.data).toEqual([{
      group_id: 999,
      group_name: 'g',
      request_id: 42,
      requester_uin: 5555,
      requester_nick: 'target',
      message: 'pls',
      checked: false, // state == 1 → un-checked
      actor: 8888,
      invitor_uin: 7777,
      invitor_nick: 'inviter',
      flag: '7:999:u_t:filtered',
    }]);
  });

  it('returns [] when the fetch throws', async () => {
    const bridge = fakeBridge({
      fetchGroupRequests: (async () => { throw new Error('boom'); }) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_group_ignored_notifies', {});
    expect(res).toMatchObject({ status: 'ok', data: [] });
  });
});

describe('extended-actions / get_group_ignore_add_request', () => {
  it('projects the same filtered list into napcat\'s ignore-add-request shape', async () => {
    const bridge = fakeBridge({
      fetchGroupRequests: (async () => [fakeFilteredRequest({ state: 2 })]) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_group_ignore_add_request', {});
    expect(res.status).toBe('ok');
    expect(res.data).toEqual([{
      request_id: 42,
      invitor_uin: 7777,
      invitor_nick: 'inviter',
      group_id: 999,
      message: 'pls',
      group_name: 'g',
      checked: true, // state == 2 → checked
      actor: 8888,
      requester_nick: 'target',
    }]);
  });
});


// ─── Tier 1: delete_group_folder alias ───

describe('extended-actions / delete_group_folder', () => {
  it('forwards to bridge.deleteGroupFileFolder', async () => {
    const deleteGroupFileFolder = vi.fn(async () => {});
    const bridge = fakeBridge({ deleteGroupFileFolder: deleteGroupFileFolder as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('delete_group_folder', {
      group_id: 100, folder_id: 'fid-1',
    });
    expect(deleteGroupFileFolder).toHaveBeenCalledWith(100, 'fid-1');
    expect(res.status).toBe('ok');
  });

  it('rejects missing fields', async () => {
    const bridge = fakeBridge({ deleteGroupFileFolder: vi.fn() as any });
    const r1 = await makeHandler(fakeCtx(bridge)).handle('delete_group_folder', { folder_id: 'x' });
    const r2 = await makeHandler(fakeCtx(bridge)).handle('delete_group_folder', { group_id: 1 });
    expect(r1).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r2).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

// ─── Tier 2: group todo ───

describe('extended-actions / set_/complete_/cancel_group_todo', () => {
  it.each([
    ['set_group_todo', 'setGroupTodo'],
    ['complete_group_todo', 'completeGroupTodo'],
    ['cancel_group_todo', 'cancelGroupTodo'],
  ] as const)('%s resolves message meta then calls bridge.%s with the sequence', async (action, method) => {
    const bridgeMethod = vi.fn(async () => {});
    const bridge = fakeBridge({ [method]: bridgeMethod } as any);
    const ctx = fakeCtx(bridge, {
      getMessageMeta: (id: number) => id === 7 ? fakeMeta({ targetId: 100, sequence: 555 }) : null,
    });
    const res = await makeHandler(ctx).handle(action, { group_id: 100, message_id: 7 });
    expect(res.status).toBe('ok');
    expect(bridgeMethod).toHaveBeenCalledWith(100, 555n);
  });

  it('rejects when message meta is missing', async () => {
    const ctx = fakeCtx(fakeBridge(), { getMessageMeta: () => null });
    const res = await makeHandler(ctx).handle('set_group_todo', { group_id: 1, message_id: 9999 });
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'message not found' });
  });

  it('rejects when message belongs to a different chat', async () => {
    const ctx = fakeCtx(fakeBridge(), {
      getMessageMeta: () => fakeMeta({ targetId: 222 }),
    });
    const res = await makeHandler(ctx).handle('set_group_todo', { group_id: 100, message_id: 1 });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });

  it('rejects when message is a private message', async () => {
    const ctx = fakeCtx(fakeBridge(), {
      getMessageMeta: () => fakeMeta({ isGroup: false }),
    });
    const res = await makeHandler(ctx).handle('set_group_todo', { group_id: 100, message_id: 1 });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });

  it('rejects missing params', async () => {
    const r1 = await makeHandler(fakeCtx(fakeBridge())).handle('set_group_todo', { message_id: 1 });
    const r2 = await makeHandler(fakeCtx(fakeBridge())).handle('set_group_todo', { group_id: 1 });
    expect(r1).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r2).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

// ─── Tier 2: nc_get_user_status ───

describe('extended-actions / nc_get_user_status', () => {
  it('returns whatever bridge.getStrangerStatus reports', async () => {
    const getStrangerStatus = vi.fn(async () => ({ status: 10, ext_status: 0x1234 }));
    const bridge = fakeBridge({ getStrangerStatus: getStrangerStatus as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('nc_get_user_status', { user_id: 999 });
    expect(getStrangerStatus).toHaveBeenCalledWith(999);
    expect(res).toMatchObject({ status: 'ok', data: { status: 10, ext_status: 0x1234 } });
  });

  it('reports action_failed when bridge returns null', async () => {
    const bridge = fakeBridge({ getStrangerStatus: (async () => null) as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('nc_get_user_status', { user_id: 1 });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });

  it('rejects missing user_id', async () => {
    const bridge = fakeBridge({ getStrangerStatus: vi.fn() as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('nc_get_user_status', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

// ─── Tier 2: AI voice trio ───

describe('extended-actions / get_ai_characters', () => {
  it('flattens server categories into {type, characters[]}', async () => {
    const fetchAiVoiceList = vi.fn(async () => [{
      category: 'cute',
      voices: [
        { voiceId: 'v1', voiceDisplayName: 'V1', voiceExampleUrl: 'http://a' },
        { voiceId: 'v2', voiceDisplayName: 'V2', voiceExampleUrl: 'http://b' },
      ],
    }]);
    const bridge = fakeBridge({ fetchAiVoiceList: fetchAiVoiceList as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_ai_characters', {
      group_id: 100, chat_type: 1,
    });
    expect(fetchAiVoiceList).toHaveBeenCalledWith(100, 1);
    expect(res.data).toEqual([{
      type: 'cute',
      characters: [
        { character_id: 'v1', character_name: 'V1', preview_url: 'http://a' },
        { character_id: 'v2', character_name: 'V2', preview_url: 'http://b' },
      ],
    }]);
  });

  it('defaults chat_type to 1 (Sound) when unspecified', async () => {
    const fetchAiVoiceList = vi.fn(async () => []);
    const bridge = fakeBridge({ fetchAiVoiceList: fetchAiVoiceList as any });
    await makeHandler(fakeCtx(bridge)).handle('get_ai_characters', { group_id: 100 });
    expect(fetchAiVoiceList).toHaveBeenCalledWith(100, 1);
  });

  it('surfaces bridge errors as action_failed', async () => {
    const bridge = fakeBridge({
      fetchAiVoiceList: (async () => { throw new Error('rate limited'); }) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_ai_characters', { group_id: 100 });
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'rate limited' });
  });
});

describe('extended-actions / get_ai_record', () => {
  it('feeds IndexNode from fetchAiVoice into fetchGroupPttUrlByNode and returns the URL', async () => {
    const node = { fileUuid: 'voice-uuid' };
    const fetchAiVoice = vi.fn(async () => node);
    const fetchGroupPttUrlByNode = vi.fn(async () => 'http://voice.silk');
    const bridge = fakeBridge({
      fetchAiVoice: fetchAiVoice as any,
      fetchGroupPttUrlByNode: fetchGroupPttUrlByNode as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_ai_record', {
      group_id: 100, character: 'v1', text: 'hello',
    });
    expect(fetchAiVoice).toHaveBeenCalledWith(100, 'v1', 'hello', 1);
    expect(fetchGroupPttUrlByNode).toHaveBeenCalledWith(100, node);
    expect(res).toMatchObject({ status: 'ok', data: 'http://voice.silk' });
  });

  it('rejects missing fields', async () => {
    const r1 = await makeHandler(fakeCtx(fakeBridge())).handle('get_ai_record', { character: 'v', text: 't' });
    const r2 = await makeHandler(fakeCtx(fakeBridge())).handle('get_ai_record', { group_id: 1, text: 't' });
    const r3 = await makeHandler(fakeCtx(fakeBridge())).handle('get_ai_record', { group_id: 1, character: 'v' });
    expect(r1).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r2).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r3).toMatchObject({ status: 'failed', retcode: 1400 });
  });

  it('reports action_failed when synthesis exhausts retries', async () => {
    const bridge = fakeBridge({
      fetchAiVoice: (async () => { throw new Error('AI voice synthesis did not complete'); }) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_ai_record', {
      group_id: 1, character: 'v', text: 't',
    });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });
});

describe('extended-actions / send_group_ai_record', () => {
  it('side-effects fetchAiVoice (no URL fetch) and returns message_id=0', async () => {
    const fetchAiVoice = vi.fn(async () => ({ fileUuid: 'uuid' }));
    const fetchGroupPttUrlByNode = vi.fn();
    const bridge = fakeBridge({
      fetchAiVoice: fetchAiVoice as any,
      fetchGroupPttUrlByNode: fetchGroupPttUrlByNode as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_group_ai_record', {
      group_id: 100, character: 'v', text: 'hi',
    });
    expect(fetchAiVoice).toHaveBeenCalledOnce();
    expect(fetchGroupPttUrlByNode).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'ok', data: { message_id: 0 } });
  });
});

// ─── Tier 3: set_diy_online_status ───

describe('extended-actions / set_diy_online_status', () => {
  it('coerces face_id / face_type from string-or-number and forwards to bridge.setDiyOnlineStatus', async () => {
    const setDiyOnlineStatus = vi.fn(async () => {});
    const bridge = fakeBridge({ setDiyOnlineStatus: setDiyOnlineStatus as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_diy_online_status', {
      face_id: '1234',
      face_type: '2',
      wording: '摸鱼中',
    });
    expect(res.status).toBe('ok');
    expect(setDiyOnlineStatus).toHaveBeenCalledWith(1234, '摸鱼中', 2);
  });

  it('defaults face_type to 1 when omitted, wording to empty string', async () => {
    const setDiyOnlineStatus = vi.fn(async () => {});
    const bridge = fakeBridge({ setDiyOnlineStatus: setDiyOnlineStatus as any });
    await makeHandler(fakeCtx(bridge)).handle('set_diy_online_status', { face_id: 99 });
    expect(setDiyOnlineStatus).toHaveBeenCalledWith(99, '', 1);
  });

  it('rejects missing face_id', async () => {
    const setDiyOnlineStatus = vi.fn();
    const bridge = fakeBridge({ setDiyOnlineStatus: setDiyOnlineStatus as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_diy_online_status', { wording: 'x' });
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(setDiyOnlineStatus).not.toHaveBeenCalled();
  });

  it('surfaces bridge errors as action_failed with the original message', async () => {
    const bridge = fakeBridge({
      setDiyOnlineStatus: (async () => { throw new Error('denied'); }) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_diy_online_status', {
      face_id: 1, wording: 'x',
    });
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'denied' });
  });
});

// ─── set_group_portrait (Lagrange-protocol highway upload, cmdId 3000) ───

describe('extended-actions / set_group_portrait', () => {
  it('forwards group_id + file to bridge.setGroupAvatar', async () => {
    const setGroupAvatar = vi.fn(async () => {});
    const bridge = fakeBridge({ setGroupAvatar: setGroupAvatar as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_group_portrait', {
      group_id: 12345, file: '/tmp/avatar.png',
    });
    expect(res.status).toBe('ok');
    expect(setGroupAvatar).toHaveBeenCalledWith(12345, '/tmp/avatar.png');
  });

  it('rejects missing group_id or file', async () => {
    const setGroupAvatar = vi.fn();
    const bridge = fakeBridge({ setGroupAvatar: setGroupAvatar as any });
    const r1 = await makeHandler(fakeCtx(bridge)).handle('set_group_portrait', { file: 'x' });
    const r2 = await makeHandler(fakeCtx(bridge)).handle('set_group_portrait', { group_id: 1 });
    expect(r1).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r2).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(setGroupAvatar).not.toHaveBeenCalled();
  });

  it('surfaces highway / decode errors as action_failed', async () => {
    const bridge = fakeBridge({
      setGroupAvatar: (async () => { throw new Error('highway 500'); }) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_group_portrait', {
      group_id: 1, file: 'x.png',
    });
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'highway 500' });
  });
});

// ─── Wave 1: get_group_shut_list ───

describe('extended-actions / get_group_shut_list', () => {
  it('returns only currently-muted members in NapCat shape', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fetchGroupMemberList = vi.fn(async () => [
      { uin: 111, uid: 'u1', nickname: 'muted', card: '', role: 'member', level: 1, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: nowSec + 3600 },
      { uin: 222, uid: 'u2', nickname: 'free', card: '', role: 'member', level: 1, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: 0 },
      { uin: 333, uid: 'u3', nickname: 'expired', card: '', role: 'member', level: 1, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: nowSec - 3600 },
    ]);
    const bridge = fakeBridge({ fetchGroupMemberList: fetchGroupMemberList as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_group_shut_list', { group_id: 12345 });
    expect(res.status).toBe('ok');
    expect(fetchGroupMemberList).toHaveBeenCalledWith(12345);
    expect(res.data).toEqual([
      { user_id: 111, nickname: 'muted', shut_up_time: nowSec + 3600 },
    ]);
  });

  it('rejects missing group_id', async () => {
    const bridge = fakeBridge({ fetchGroupMemberList: vi.fn() as any });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_group_shut_list', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

// ─── Wave 1: get_file (compose image→record cache) ───

describe('extended-actions / get_file', () => {
  const imageInfo = { file: 'a.jpg', url: 'http://x/a.jpg', file_size: '12', file_name: 'a.jpg' };
  const recordInfo = { file: 'b.amr', url: 'http://x/b.amr', file_size: '34', file_name: 'b.amr' };

  it('resolves an image file_id via the image cache', async () => {
    const getImageInfo = vi.fn(async () => imageInfo);
    const getRecordInfo = vi.fn(async () => null);
    const res = await makeHandler(fakeCtx(fakeBridge(), { getImageInfo, getRecordInfo })).handle('get_file', { file_id: 'a.jpg' });
    expect(res).toMatchObject({ status: 'ok', data: imageInfo });
    expect(getRecordInfo).not.toHaveBeenCalled();
  });

  it('falls back to the record cache when not an image', async () => {
    const getImageInfo = vi.fn(async () => null);
    const getRecordInfo = vi.fn(async () => recordInfo);
    const res = await makeHandler(fakeCtx(fakeBridge(), { getImageInfo, getRecordInfo })).handle('get_file', { file: 'b.amr' });
    expect(res).toMatchObject({ status: 'ok', data: recordInfo });
  });

  it('fails with a neutral cache-miss message that points to the group-file path', async () => {
    // A double cache miss is runtime-indistinguishable between "a group-file
    // file_id was passed (unsupported here)" and "the image/voice really isn't
    // cached" — run() does not parse the id's shape. So the error must stay
    // neutral: state the cache miss, then offer the group-file path as
    // guidance, without asserting "unsupported".
    const getImageInfo = vi.fn(async () => null);
    const getRecordInfo = vi.fn(async () => null);
    const res = await makeHandler(fakeCtx(fakeBridge(), { getImageInfo, getRecordInfo })).handle('get_file', { file_id: 'nope' });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    const wording = (res as { wording?: string }).wording ?? '';
    expect(wording).toMatch(/not found in the image\/voice cache/);
    expect(wording).toMatch(/get_group_file_url/);
    expect(wording).not.toMatch(/unsupported/);
  });

  it('rejects when neither file nor file_id is given', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('get_file', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

// ─── Wave 2: rename_group_file (0x6D6_4) ───

describe('extended-actions / rename_group_file', () => {
  it('renames a group file via apis.groupFile.rename', async () => {
    const rename = vi.fn(async () => undefined);
    const bridge = fakeBridge({ apis: { groupFile: { rename } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('rename_group_file', {
      group_id: 12345, file_id: '/abc', current_parent_directory: '/', new_name: 'new.txt',
    });
    expect(res.status).toBe('ok');
    expect(rename).toHaveBeenCalledWith(12345, '/abc', '/', 'new.txt');
  });

  it('rejects missing required params', async () => {
    const rename = vi.fn();
    const bridge = fakeBridge({ apis: { groupFile: { rename } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('rename_group_file', { group_id: 12345, file_id: '/abc' });
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(rename).not.toHaveBeenCalled();
  });

  it('surfaces oidb errors (handler maps a thrown error to INTERNAL_ERROR, as its sibling file ops do)', async () => {
    const rename = vi.fn(async () => { throw new Error('rename rejected'); });
    const bridge = fakeBridge({ apis: { groupFile: { rename } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('rename_group_file', {
      group_id: 1, file_id: '/a', current_parent_directory: '/', new_name: 'x',
    });
    expect(res).toMatchObject({ status: 'failed', retcode: 1200, wording: 'rename rejected' });
  });
});

// ─── Wave 2: get_rkey_server ───

describe('extended-actions / get_rkey_server', () => {
  it('reshapes download rkeys into the NapCat server shape (private=10, group=20)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const getDownloadRKeys = vi.fn(async () => [
      { rkey: '&rkey=PRIV', type: 10, ttl: 3600, create_time: 100 },
      { rkey: '&rkey=GRP', type: 20, ttl: 7200, create_time: 200 },
    ]);
    const res = await makeHandler(fakeCtx(fakeBridge(), { getDownloadRKeys })).handle('get_rkey_server', {});
    expect(res.status).toBe('ok');
    const d = res.data as { private_rkey?: string; group_rkey?: string; expired_time: number; name: string };
    expect(d.private_rkey).toBe('&rkey=PRIV');
    expect(d.group_rkey).toBe('&rkey=GRP');
    expect(d.name).toBe('SnowLuma');
    // expiry = now + min(ttl) = now + 3600 (allow a 1s clock tick)
    expect(d.expired_time).toBeGreaterThanOrEqual(nowSec + 3600);
    expect(d.expired_time).toBeLessThanOrEqual(nowSec + 3601);
  });

  it('leaves a missing scope undefined', async () => {
    const getDownloadRKeys = vi.fn(async () => [
      { rkey: '&rkey=PRIV', type: 10, ttl: 3600, create_time: 100 },
    ]);
    const res = await makeHandler(fakeCtx(fakeBridge(), { getDownloadRKeys })).handle('get_rkey_server', {});
    const d = res.data as { private_rkey?: string; group_rkey?: string };
    expect(d.private_rkey).toBe('&rkey=PRIV');
    expect(d.group_rkey).toBeUndefined();
  });

  it('fails (not an expired empty shell) when no rkey is available', async () => {
    const getDownloadRKeys = vi.fn(async () => []);
    const res = await makeHandler(fakeCtx(fakeBridge(), { getDownloadRKeys })).handle('get_rkey_server', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });
});

// ─── Wave 3: ocr_image / .ocr_image (OIDB 0xE07_0) ───

describe('extended-actions / ocr_image', () => {
  const ocrResult = { texts: [{ text: 'hello', confidence: 99, coordinates: [{ x: 1, y: 2 }] }], language: 'en' };

  it('OCRs an http(s) image URL directly', async () => {
    const ocrImage = vi.fn(async () => ocrResult);
    const bridge = fakeBridge({ apis: { misc: { ocrImage } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('ocr_image', { image: 'https://x/a.jpg' });
    expect(res).toMatchObject({ status: 'ok', data: ocrResult });
    expect(ocrImage).toHaveBeenCalledWith('https://x/a.jpg');
  });

  it('resolves a cached image file_id to a url via getImageInfo', async () => {
    const ocrImage = vi.fn(async () => ocrResult);
    const getImageInfo = vi.fn(async () => ({ url: 'https://cdn/resolved.jpg' }));
    const bridge = fakeBridge({ apis: { misc: { ocrImage } } });
    const res = await makeHandler(fakeCtx(bridge, { getImageInfo })).handle('ocr_image', { image: 'abc.jpg' });
    expect(res.status).toBe('ok');
    expect(ocrImage).toHaveBeenCalledWith('https://cdn/resolved.jpg');
  });

  it('.ocr_image shares the same handler', async () => {
    const ocrImage = vi.fn(async () => ocrResult);
    const bridge = fakeBridge({ apis: { misc: { ocrImage } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('.ocr_image', { image: 'http://x/a.jpg' });
    expect(res.status).toBe('ok');
  });

  it('fails when the id cannot be resolved to a url', async () => {
    const ocrImage = vi.fn();
    const getImageInfo = vi.fn(async () => null);
    const bridge = fakeBridge({ apis: { misc: { ocrImage } } });
    const res = await makeHandler(fakeCtx(bridge, { getImageInfo })).handle('ocr_image', { image: 'unknown' });
    expect(res.status).toBe('failed');
    expect(ocrImage).not.toHaveBeenCalled();
  });

  it('rejects missing image', async () => {
    const bridge = fakeBridge({ apis: { misc: { ocrImage: vi.fn() } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('ocr_image', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

// ─── TierB Phase 1: compat stubs (model_show / online_clients / mark_all_as_read) ───
// These are kernel-only in NapCat (mock/no-op), so SnowLuma ships honest
// compat shapes rather than RE-ing a wire that doesn't exist. We pin the
// response *shape* of each. NOTE two deliberate divergences from NapCat:
//   • _get_model_show reuses NapCat's array/variants shape but ECHOES the
//     requested model instead of NapCat's hardcoded 'napcat'.
//   • get_online_clients returns the OneBot-v11/go-cqhttp { clients: [] }
//     envelope, NOT NapCat's (non-standard) bare []. A strict-NapCat client
//     would expect an array here; we intentionally follow the spec instead.

describe('extended-actions / TierB compat stubs', () => {
  it('_get_model_show returns the napcat-shaped variants array, echoing the model', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('_get_model_show', { model: 'MyPhone' });
    expect(res.status).toBe('ok');
    // NapCat shape: data = [{ variants: { model_show, need_pay } }]
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toHaveLength(1);
    expect((res.data as any)[0].variants).toMatchObject({ model_show: 'MyPhone', need_pay: false });
  });

  it('_get_model_show defaults model_show to snowluma when model is absent or empty', async () => {
    for (const params of [{}, { model: '' }]) {
      const res = await makeHandler(fakeCtx(fakeBridge())).handle('_get_model_show', params);
      expect(res.status).toBe('ok');
      expect((res.data as any)[0].variants.model_show).toBe('snowluma');
      expect((res.data as any)[0].variants.need_pay).toBe(false);
    }
  });

  it('_set_model_show is an accepted no-op', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('_set_model_show', { model: 'x', model_show: 'y' });
    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: null });
  });

  it('get_online_clients returns the OneBot-standard {clients:[]} envelope', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('get_online_clients', {});
    expect(res.status).toBe('ok');
    expect(res.data).toMatchObject({ clients: [] });
  });

  it('_mark_all_as_read is an accepted no-op', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('_mark_all_as_read', {});
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
  });
});

// ─── TierB ①: get_group_signed_list (qun.qq.com HTTP, real) ───
// Thin wrapper over WebApi.getSignedList; we pin that the action drives
// the web api with the numeric group id and passes the mapped list through.

describe('extended-actions / get_group_signed_list', () => {
  it('calls web.getSignedList with the group id and returns the list', async () => {
    const list = [{ user_id: 10001, nick: 'Alice', time: 1700000000, rank: 1 }];
    const getSignedList = vi.fn(async () => list);
    const bridge = fakeBridge({ apis: { web: { getSignedList } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_group_signed_list', { group_id: 12345 });
    expect(getSignedList).toHaveBeenCalledWith(12345);
    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: list });
  });

  it('surfaces a failure as a failed response', async () => {
    const getSignedList = vi.fn(async () => { throw new Error('no pskey'); });
    const bridge = fakeBridge({ apis: { web: { getSignedList } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_group_signed_list', { group_id: 12345 });
    expect(res.status).toBe('failed');
  });
});

// ─── TierB ②: get_recent_contact (documented stub) ───
// QQ's recent-contact list is a kernel-local snapshot with rich peer
// metadata (peerName/remark/lastestMsg) that SnowLuma can't reproduce —
// there's no SSO/packet wire, and the bot's own message store only covers
// sessions it observed and lacks those fields. Rather than ship a
// divergent approximation under a name implying QQ's native list, we
// return an honest empty list and accept the `count` param for compat.
describe('extended-actions / get_recent_contact stub', () => {
  it('returns an empty list and accepts count', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('get_recent_contact', { count: 10 });
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
    expect(res.data).toEqual([]);
  });

  it('works with no params', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('get_recent_contact', {});
    expect(res).toMatchObject({ status: 'ok', data: [] });
  });
});

// ─── TierB ③: RE'd OIDB-backed actions (wiring through handle) ───
describe('extended-actions / TierB ③ share + doubt + robot-option', () => {
  it('share_peer with user_id calls getBuddyRecommendArk and wraps the ark', async () => {
    const getBuddyRecommendArk = vi.fn(async () => '{"app":"x"}');
    const bridge = fakeBridge({ apis: { contacts: { getBuddyRecommendArk } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('share_peer', { user_id: 10000 });
    expect(getBuddyRecommendArk).toHaveBeenCalledWith(10000, '');
    expect(res).toMatchObject({ status: 'ok', data: { arkMsg: '{"app":"x"}' } });
  });

  it('share_peer with group_id calls getGroupRecommendArk', async () => {
    const getGroupRecommendArk = vi.fn(async () => '{"app":"g"}');
    const bridge = fakeBridge({ apis: { contacts: { getGroupRecommendArk } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('share_peer', { group_id: 555 });
    expect(getGroupRecommendArk).toHaveBeenCalledWith(555);
    expect(res).toMatchObject({ status: 'ok', data: { arkMsg: '{"app":"g"}' } });
  });

  it('share_peer with neither id fails', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('share_peer', {});
    expect(res.status).toBe('failed');
  });

  it('send_ark_share shares the buddy/group routing', async () => {
    const getBuddyRecommendArk = vi.fn(async () => 'ARK');
    const bridge = fakeBridge({ apis: { contacts: { getBuddyRecommendArk } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_ark_share', { user_id: 1, phone_number: '99' });
    expect(getBuddyRecommendArk).toHaveBeenCalledWith(1, '99');
    expect(res).toMatchObject({ status: 'ok', data: { arkMsg: 'ARK' } });
  });

  it('share_group_ex / send_group_ark_share return the group ark string', async () => {
    const getGroupRecommendArk = vi.fn(async () => 'GROUP_ARK');
    const bridge = fakeBridge({ apis: { contacts: { getGroupRecommendArk } } });
    for (const name of ['share_group_ex', 'send_group_ark_share']) {
      const res = await makeHandler(fakeCtx(bridge)).handle(name, { group_id: 42 });
      expect(res).toMatchObject({ status: 'ok', data: 'GROUP_ARK' });
    }
    expect(getGroupRecommendArk).toHaveBeenCalledWith(42);
  });

  it('get_doubt_friends_add_request returns the mapped list', async () => {
    const list = [{ uid: 'u1', nick: 'A', source: 's', msg: 'm', reqTime: 123 }];
    const getDoubtRequests = vi.fn(async () => list);
    const bridge = fakeBridge({ apis: { friend: { getDoubtRequests } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_doubt_friends_add_request', { count: 5 });
    expect(getDoubtRequests).toHaveBeenCalledWith(5);
    expect(res).toMatchObject({ status: 'ok', data: list });
  });

  it('set_doubt_friends_add_request approves by flag (uid)', async () => {
    const approveDoubtRequest = vi.fn(async () => {});
    const bridge = fakeBridge({ apis: { friend: { approveDoubtRequest } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_doubt_friends_add_request', { flag: 'u_abc', approve: true });
    expect(approveDoubtRequest).toHaveBeenCalledWith('u_abc');
    expect(res).toMatchObject({ status: 'ok' });
  });

  it('set_doubt_friends_add_request with approve:false calls rejectDoubtRequest (not approve)', async () => {
    const approveDoubtRequest = vi.fn(async () => {});
    const rejectDoubtRequest = vi.fn(async () => {});
    const bridge = fakeBridge({ apis: { friend: { approveDoubtRequest, rejectDoubtRequest } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_doubt_friends_add_request', { flag: 'u_abc', approve: false });
    expect(res).toMatchObject({ status: 'ok' });
    expect(rejectDoubtRequest).toHaveBeenCalledWith('u_abc');
    expect(approveDoubtRequest).not.toHaveBeenCalled();
  });

  it('set_group_robot_add_option forwards group + switch/examine', async () => {
    const setRobotAddOption = vi.fn(async () => {});
    const bridge = fakeBridge({ apis: { groupAdmin: { setRobotAddOption } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('set_group_robot_add_option', { group_id: 12345, robot_member_switch: 1, robot_member_examine: 2 });
    expect(setRobotAddOption).toHaveBeenCalledWith(12345, 1, 2);
    expect(res).toMatchObject({ status: 'ok' });
  });
});

// ─── napcat-parity: get_qun_album_list (NapCat-shaped envelope over existing web API) ───
// SnowLuma already exposes the qun_list_album_v2 web API as get_group_album_list
// (raw array). NapCat's get_qun_album_list wraps it as {album_list, attach_info,
// has_more} with {album_id, album_name, create_time, ...} items. We add the
// NapCat-named/shaped action reusing the same bridge call.
describe('extended-actions / get_qun_album_list', () => {
  it('maps the album list into the napcat {album_list, attach_info, has_more} envelope', async () => {
    const list = vi.fn(async () => [
      { id: 'a1', name: '相册一', picNum: 5, createTime: 1700000000 },
      { id: 'a2', name: '相册二', picNum: 0, createTime: 1700000100 },
    ]);
    const bridge = fakeBridge({ apis: { groupAlbum: { list } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_qun_album_list', { group_id: 12345 });
    expect(list).toHaveBeenCalledWith(12345);
    expect(res.status).toBe('ok');
    expect(res.data).toMatchObject({ attach_info: '', has_more: false });
    expect((res.data as any).album_list).toEqual([
      { album_id: 'a1', album_name: '相册一', create_time: 1700000000, pic_num: 5 },
      { album_id: 'a2', album_name: '相册二', create_time: 1700000100, pic_num: 0 },
    ]);
  });

  it('surfaces failure as a failed response', async () => {
    const list = vi.fn(async () => { throw new Error('no pskey'); });
    const bridge = fakeBridge({ apis: { groupAlbum: { list } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_qun_album_list', { group_id: 1 });
    expect(res.status).toBe('failed');
  });
});

// ─── flash-transfer: download_fileset (闪传文件集下载到本地) ───
// 接线测试：参数校验 + facade 错误传播。完整下载链路（0x93d3/0x93d4 取链接 →
// HTTP GET → 落盘 data/downloads）依赖真实 OIDB 与文件系统，与 download_file
// 一样靠端到端验证，此处不重复 mock fetch/fs。
describe('extended-actions / download_fileset', () => {
  it('rejects missing fileset_id', async () => {
    const downloadFileset = vi.fn(async () => ({ url: '', fileName: '', fileSize: 0 }));
    const bridge = fakeBridge({ apis: { flashTransfer: { downloadFileset: downloadFileset as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('download_fileset', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(downloadFileset).not.toHaveBeenCalled();
  });

  it('surfaces facade errors as action_failed', async () => {
    const downloadFileset = vi.fn(async () => { throw new Error('no download url available'); });
    const bridge = fakeBridge({ apis: { flashTransfer: { downloadFileset: downloadFileset as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('download_fileset', { fileset_id: 'abc' });
    expect(downloadFileset).toHaveBeenCalledOnce();
    expect(downloadFileset.mock.calls[0]![0]).toBe('abc');
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'no download url available' });
  });
});

// ─── flash-transfer: send_flash_msg (0x93d7 发送闪传文件) ───
// 接线测试：参数校验 + 私聊/群聊转发 + 错误传播。完整链路（user_id→uid / group_id →
// 0x93d7）依赖真实 identity 与 OIDB，靠 send_packet 端到端验证。
describe('extended-actions / send_flash_msg', () => {
  it('rejects when neither user_id nor group_id given', async () => {
    const sendFlashMsg = vi.fn(async () => {});
    const bridge = fakeBridge({ apis: { flashTransfer: { sendFlashMsg: sendFlashMsg as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_flash_msg', { fileset_id: 'abc' });
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(sendFlashMsg).not.toHaveBeenCalled();
  });

  it('forwards fileset_id + user_id (private) and returns message_id 0', async () => {
    const sendFlashMsg = vi.fn(async () => {});
    const bridge = fakeBridge({ apis: { flashTransfer: { sendFlashMsg: sendFlashMsg as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_flash_msg', { fileset_id: 'fs-1', user_id: 12345 });
    expect(sendFlashMsg).toHaveBeenCalledWith('fs-1', { userId: 12345, groupId: undefined });
    expect(res).toMatchObject({ status: 'ok', data: { message_id: 0 } });
  });

  it('forwards fileset_id + group_id (group) and returns message_id 0', async () => {
    const sendFlashMsg = vi.fn(async () => {});
    const bridge = fakeBridge({ apis: { flashTransfer: { sendFlashMsg: sendFlashMsg as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_flash_msg', { fileset_id: 'fs-1', group_id: 1017438661 });
    expect(sendFlashMsg).toHaveBeenCalledWith('fs-1', { userId: undefined, groupId: 1017438661 });
    expect(res).toMatchObject({ status: 'ok', data: { message_id: 0 } });
  });

  it('surfaces facade errors (e.g. uid resolve failed) as action_failed', async () => {
    const sendFlashMsg = vi.fn(async () => { throw new Error('failed to resolve UID for UIN 999'); });
    const bridge = fakeBridge({ apis: { flashTransfer: { sendFlashMsg: sendFlashMsg as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_flash_msg', { fileset_id: 'fs-1', user_id: 999 });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });
});

// ─── flash-transfer: get_fileset_id (分享码→fileset_id, HTTP 网页解析) ───
describe('extended-actions / get_fileset_id', () => {
  it('forwards share_code to facade and returns fileset_id', async () => {
    const getFilesetIdByCode = vi.fn(async () => '8e40afa1-829d-498b-852f-092394ddb31f');
    const bridge = fakeBridge({ apis: { flashTransfer: { getFilesetIdByCode: getFilesetIdByCode as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_fileset_id', { share_code: 'K0sEqhYria' });
    expect(getFilesetIdByCode).toHaveBeenCalledWith('K0sEqhYria');
    expect(res).toMatchObject({ status: 'ok', data: { fileset_id: '8e40afa1-829d-498b-852f-092394ddb31f' } });
  });

  it('rejects missing share_code', async () => {
    const getFilesetIdByCode = vi.fn(async () => 'x');
    const bridge = fakeBridge({ apis: { flashTransfer: { getFilesetIdByCode: getFilesetIdByCode as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_fileset_id', {});
    expect(res).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(getFilesetIdByCode).not.toHaveBeenCalled();
  });

  it('surfaces facade errors (e.g. not found) as action_failed', async () => {
    const getFilesetIdByCode = vi.fn(async () => { throw new Error('get_fileset_id: fileset_id not found in share page'); });
    const bridge = fakeBridge({ apis: { flashTransfer: { getFilesetIdByCode: getFilesetIdByCode as any } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_fileset_id', { share_code: 'invalid' });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
  });
});
