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

describe('extended-actions / get_group_shut_list', () => {
  it('returns empty list (oidb not yet wrapped)', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge())).handle('get_group_shut_list', {});
    expect(res).toEqual({ status: 'ok', retcode: 0, data: [] });
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
