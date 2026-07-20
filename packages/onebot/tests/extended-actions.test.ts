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
import { GROUP_MESSAGE_EVENT, hashMessageIdInt32 } from '../src/message-id';

function fakeMeta(overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    isGroup: true,
    targetId: 100,
    sequence: 555,
    sequenceAuthoritative: true,
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
  fetchFriendCategories: ['contacts', 'fetchFriendCategories'],
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
  sendAiVoice: ['extras', 'sendAiVoice'],
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
    listReadSessions: () => ({ groupIds: [], privateUserIds: [] }),
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

describe('extended-actions / set_self_longnick', () => {
  it('accepts an empty longNick to clear the signature', async () => {
    const setSelfLongNick = vi.fn(async () => undefined);
    const bridge = fakeBridge({ setSelfLongNick });

    const response = await makeHandler(fakeCtx(bridge)).handle('set_self_longnick', {
      longNick: '',
    });

    expect(response).toMatchObject({ status: 'ok', retcode: 0 });
    expect(setSelfLongNick).toHaveBeenCalledWith('');
  });

  it('accepts an empty long_nick compatibility alias', async () => {
    const setSelfLongNick = vi.fn(async () => undefined);
    const bridge = fakeBridge({ setSelfLongNick });

    const response = await makeHandler(fakeCtx(bridge)).handle('set_self_longnick', {
      long_nick: '',
    });

    expect(response).toMatchObject({ status: 'ok', retcode: 0 });
    expect(setSelfLongNick).toHaveBeenCalledWith('');
  });

  it.each([
    ['missing value', {}],
    ['non-string value', { longNick: 0 }],
  ])('rejects %s without calling the bridge', async (_case, params) => {
    const setSelfLongNick = vi.fn(async () => undefined);
    const bridge = fakeBridge({ setSelfLongNick });

    const response = await makeHandler(fakeCtx(bridge)).handle('set_self_longnick', params);

    expect(response).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(setSelfLongNick).not.toHaveBeenCalled();
  });
});

describe('extended-actions / group notice options', () => {
  it('coerces and forwards every supported announcement option', async () => {
    const sendNotice = vi.fn(async () => ({ ec: 0 }));
    const bridge = fakeBridge({ apis: { web: { sendNotice } } });

    const response = await makeHandler(fakeCtx(bridge)).handle('_send_group_notice', {
      group_id: '941657197',
      content: 'announcement option test',
      pinned: '1',
      type: '20',
      send_to_new_members: 'true',
      is_show_edit_card: '0',
      tip_window_type: '0',
      confirm_required: '0',
    });

    expect(response).toMatchObject({ status: 'ok', retcode: 0 });
    expect(sendNotice).toHaveBeenCalledWith(941657197, 'announcement option test', {
      image: undefined,
      pinned: 1,
      type: 20,
      sendToNewMembers: true,
      isShowEditCard: 0,
      tipWindowType: 0,
      confirmRequired: 0,
    });
  });

  it('rejects a semantic/raw target conflict without calling the bridge', async () => {
    const sendNotice = vi.fn();
    const bridge = fakeBridge({ apis: { web: { sendNotice } } });

    const response = await makeHandler(fakeCtx(bridge)).handle('_send_group_notice', {
      group_id: 941657197,
      content: 'conflict',
      type: 1,
      send_to_new_members: true,
    });

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 1400,
      wording: 'send_to_new_members conflicts with type',
    });
    expect(sendNotice).not.toHaveBeenCalled();
  });

  it('rejects an unverified publish type without calling the bridge', async () => {
    const sendNotice = vi.fn();
    const bridge = fakeBridge({ apis: { web: { sendNotice } } });

    const response = await makeHandler(fakeCtx(bridge)).handle('_send_group_notice', {
      group_id: 941657197,
      content: 'unsupported',
      type: 6,
    });

    expect(response).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(sendNotice).not.toHaveBeenCalled();
  });
});

describe('extended-actions / get_friends_with_category', () => {
  it('returns the exact categorized friend contract', async () => {
    const fetchFriendCategories = vi.fn(async () => [{
      categoryId: 7,
      categoryName: 'Work',
      memberCount: 1,
      sortId: 3,
      friends: [{ uin: 10001, uid: 'u1', nickname: 'Alice', remark: 'A' }],
    }]);
    const bridge = fakeBridge({ fetchFriendCategories });
    const response = await makeHandler(fakeCtx(bridge))
      .handle('get_friends_with_category', {});

    expect(fetchFriendCategories).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ status: 'ok', retcode: 0 });
    expect(response.data).toEqual([{
      categoryId: 7,
      categoryName: 'Work',
      categoryMbCount: 1,
      buddyList: [{ user_id: 10001, nickname: 'Alice', remark: 'A' }],
    }]);
  });

  it('surfaces categorized fetch failures', async () => {
    const bridge = fakeBridge({
      fetchFriendCategories: vi.fn(async () => {
        throw new Error('repeated friend-list cookie aa');
      }),
    });
    const response = await makeHandler(fakeCtx(bridge))
      .handle('get_friends_with_category', {});

    expect(response).toMatchObject({
      status: 'failed',
      retcode: 100,
      wording: 'repeated friend-list cookie aa',
    });
  });
});

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
  it('forwards an explicit newer-first direction for group history', async () => {
    const getGroupMsgHistory = vi.fn(async (_groupId: number, _messageId: number, _count: number, reverseOrder: boolean) => [{
      message_id: -1,
      message_type: 'group',
      direction: reverseOrder ? 'older' : 'newer',
    }]);
    const ctx = fakeCtx(fakeBridge(), { getGroupMsgHistory } as any);

    const res = await makeHandler(ctx).handle('get_group_msg_history', {
      group_id: 100,
      message_id: -497311472,
      count: 25,
      reverse_order: false,
    });

    expect(res).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { messages: [{ direction: 'newer' }] },
    });
  });

  it('get_group_msg_history forwards a negative anchor to the handler', async () => {
    const getGroupMsgHistory = vi.fn(async (_groupId: number, messageId: number) => [{
      message_id: messageId,
      message_type: 'group',
    }]);
    const ctx = fakeCtx(fakeBridge(), { getGroupMsgHistory } as any);
    const res = await makeHandler(ctx).handle('get_group_msg_history', {
      group_id: 100, message_id: -497311472, count: 100,
    });
    expect(res).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { messages: [{ message_id: -497311472 }] },
    });
  });

  it('get_friend_msg_history forwards a negative anchor to the handler', async () => {
    const getFriendMsgHistory = vi.fn(async (_userId: number, messageId: number) => [{
      message_id: messageId,
      message_type: 'private',
    }]);
    const ctx = fakeCtx(fakeBridge(), { getFriendMsgHistory } as any);
    const res = await makeHandler(ctx).handle('get_friend_msg_history', {
      user_id: 12345, message_id: -670862300, count: 100,
    });
    expect(res).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { messages: [{ message_id: -670862300 }] },
    });
  });

  it('forwards an explicit newer-first direction for friend history', async () => {
    const getFriendMsgHistory = vi.fn(async (_userId: number, _messageId: number, _count: number, reverseOrder: boolean) => [{
      message_id: -1,
      message_type: 'private',
      direction: reverseOrder ? 'older' : 'newer',
    }]);
    const ctx = fakeCtx(fakeBridge(), { getFriendMsgHistory } as any);

    const res = await makeHandler(ctx).handle('get_friend_msg_history', {
      user_id: 12345,
      message_id: -670862300,
      count: 25,
      reverse_order: false,
    });

    expect(res).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { messages: [{ direction: 'newer' }] },
    });
  });

  it('still defaults an absent message_id to 0 (fetch-latest semantics)', async () => {
    const getGroupMsgHistory = vi.fn(async (_groupId: number, messageId: number, _count: number, reverseOrder: boolean) => [{
      message_id: messageId,
      direction: reverseOrder ? 'older' : 'newer',
    }]);
    const ctx = fakeCtx(fakeBridge(), { getGroupMsgHistory } as any);
    const res = await makeHandler(ctx).handle('get_group_msg_history', { group_id: 100 });
    expect(res).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { messages: [{ message_id: 0, direction: 'older' }] },
    });
  });
});

describe('extended-actions / mark conversation read', () => {
  it('uses a group message only to identify the conversation', async () => {
    const markGroupRead = vi.fn(async () => undefined);
    const bridge = fakeBridge({ apis: { message: { markGroupRead } } });
    const ctx = fakeCtx(bridge, {
      getMessageMeta: () => fakeMeta({ targetId: 12345, sequence: 42708 }),
    });

    const res = await makeHandler(ctx).handle('mark_group_msg_as_read', { message_id: 1 });

    expect(markGroupRead).toHaveBeenCalledWith(12345);
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
  });

  it('routes a private message to the C2C read implementation without forwarding its header sequence', async () => {
    const markPrivateRead = vi.fn(async () => undefined);
    const bridge = fakeBridge({ apis: { message: { markPrivateRead } } });
    const ctx = fakeCtx(bridge, {
      getMessageMeta: () => fakeMeta({ isGroup: false, targetId: 1787882683, sequence: 42708 }),
    });

    const res = await makeHandler(ctx).handle('mark_private_msg_as_read', { message_id: 1 });

    expect(markPrivateRead).toHaveBeenCalledWith(1787882683);
    expect(res).toMatchObject({ status: 'ok', retcode: 0 });
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

  it('rejects a local-only message id without calling the group todo protocol', async () => {
    const setGroupTodo = vi.fn(async () => {});
    const bridge = fakeBridge({ setGroupTodo });
    const ctx = fakeCtx(bridge, {
      getMessageMeta: () => fakeMeta({ sequence: 0, sequenceAuthoritative: false }),
    });

    const res = await makeHandler(ctx).handle('set_group_todo', { group_id: 100, message_id: 1 });

    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    expect(setGroupTodo).not.toHaveBeenCalled();
  });

  it('rejects missing params', async () => {
    const r1 = await makeHandler(fakeCtx(fakeBridge())).handle('set_group_todo', { message_id: 1 });
    const r2 = await makeHandler(fakeCtx(fakeBridge())).handle('set_group_todo', { group_id: 1 });
    expect(r1).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r2).toMatchObject({ status: 'failed', retcode: 1400 });
  });
});

describe('extended-actions / set_group_reaction', () => {
  it('rejects a local-only message id without calling the reaction protocol', async () => {
    const setGroupReaction = vi.fn(async () => {});
    const bridge = fakeBridge({ setGroupReaction });
    const ctx = fakeCtx(bridge, {
      getMessageMeta: () => fakeMeta({ sequence: 0, sequenceAuthoritative: false }),
    });

    const res = await makeHandler(ctx).handle('set_group_reaction', {
      group_id: 100,
      message_id: 1,
      code: '66',
      is_set: true,
    });

    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    expect(setGroupReaction).not.toHaveBeenCalled();
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
  it('returns the canonical group message id from the matched self-message receipt', async () => {
    const sendAiVoice = vi.fn(async () => ({
      sequence: 319,
    }));
    const fetchGroupPttUrlByNode = vi.fn();
    const bridge = fakeBridge({
      sendAiVoice: sendAiVoice as any,
      fetchGroupPttUrlByNode: fetchGroupPttUrlByNode as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_group_ai_record', {
      group_id: 100, character: 'v', text: 'hi',
    });
    expect(sendAiVoice).toHaveBeenCalledWith(100, 'v', 'hi', 1);
    expect(fetchGroupPttUrlByNode).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      status: 'ok',
      data: { message_id: hashMessageIdInt32(319, 100, GROUP_MESSAGE_EVENT) },
    });
  });

  it('surfaces a missing canonical receipt instead of returning a fake id', async () => {
    const bridge = fakeBridge({
      sendAiVoice: (async () => {
        throw new Error('AI voice was published but no matching group-message receipt arrived');
      }) as any,
    });
    const res = await makeHandler(fakeCtx(bridge)).handle('send_group_ai_record', {
      group_id: 100, character: 'v', text: 'hi',
    });
    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    expect(res.wording).toMatch(/group-message receipt/i);
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

// ─── Wave 1: trans_group_file (0x6D9_0) ───

describe('extended-actions / trans_group_file', () => {
  it('forwards group_id + file_id to apis.groupFile.trans and returns ok:true', async () => {
    const trans = vi.fn(async () => ({ saveBusId: 102, saveFilePath: '/saved/path' }));
    const bridge = fakeBridge({ apis: { groupFile: { trans } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('trans_group_file', {
      group_id: 12345,
      file_id: 'fid-trans',
    });
    expect(trans).toHaveBeenCalledWith(12345, 'fid-trans');
    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: { ok: true } });
  });

  it('rejects missing required params', async () => {
    const trans = vi.fn();
    const bridge = fakeBridge({ apis: { groupFile: { trans } } });
    const r1 = await makeHandler(fakeCtx(bridge)).handle('trans_group_file', { file_id: 'fid' });
    const r2 = await makeHandler(fakeCtx(bridge)).handle('trans_group_file', { group_id: 12345 });
    expect(r1).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(r2).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(trans).not.toHaveBeenCalled();
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

  it('surfaces oidb errors — a thrown error maps to the single seam (ACTION_FAILED 100 + message)', async () => {
    const rename = vi.fn(async () => { throw new Error('rename rejected'); });
    const bridge = fakeBridge({ apis: { groupFile: { rename } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('rename_group_file', {
      group_id: 1, file_id: '/a', current_parent_directory: '/', new_name: 'x',
    });
    expect(res).toMatchObject({ status: 'failed', retcode: 100, wording: 'rename rejected' });
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

// ─── TierB Phase 1: compatibility actions ───
// NOTE two deliberate divergences from NapCat:
//   • _get_model_show reuses NapCat's array/variants shape but ECHOES the
//     requested model instead of NapCat's hardcoded 'napcat'.
//   • get_online_clients returns the OneBot-v11/go-cqhttp { clients }
//     envelope, NOT NapCat's (non-standard) bare array. Its contents come from
//     the latest QQ online-device snapshot observed by this Bridge lifecycle.

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

  it('get_online_clients returns the latest observed QQ device snapshot', async () => {
    const getOnlineClients = vi.fn(() => [{
      appId: 537242075,
      instanceId: 202,
      clientType: 1,
      platform: 3,
      deviceName: 'DESKTOP-TEST',
      deviceKind: 'computer',
    }]);
    const res = await makeHandler(fakeCtx(fakeBridge({ getOnlineClients })))
      .handle('get_online_clients', {});

    expect(getOnlineClients).toHaveBeenCalledOnce();
    expect(res).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: {
        clients: [{
          app_id: 537242075,
          device_name: 'DESKTOP-TEST',
          device_kind: '电脑',
        }],
      },
    });
  });

  it('get_online_clients reports an unavailable snapshot instead of a false empty list', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge({ getOnlineClients: () => null })))
      .handle('get_online_clients', {});

    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    expect(res.wording).toMatch(/snapshot has not been observed/i);
  });

  it('get_online_clients preserves an observed empty snapshot as a successful result', async () => {
    const res = await makeHandler(fakeCtx(fakeBridge({ getOnlineClients: () => [] })))
      .handle('get_online_clients', {});

    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: { clients: [] } });
  });

  it('get_online_clients rejects a forced refresh that QQ does not expose on the packet wire', async () => {
    const getOnlineClients = vi.fn(() => []);
    const res = await makeHandler(fakeCtx(fakeBridge({ getOnlineClients })))
      .handle('get_online_clients', { no_cache: true });

    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    expect(res.wording).toMatch(/fresh refresh is unavailable/i);
    expect(getOnlineClients).not.toHaveBeenCalled();
  });

  it('_mark_all_as_read passes every observed session to the batched SSO implementation', async () => {
    const markAllRead = vi.fn(async () => undefined);
    const bridge = fakeBridge({ apis: { message: { markAllRead } } });
    const res = await makeHandler(fakeCtx(bridge, {
      listReadSessions: () => ({ groupIds: [101, 102], privateUserIds: [201] }),
    })).handle('_mark_all_as_read', {});

    expect(markAllRead).toHaveBeenCalledWith([101, 102], [201]);
    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: null });
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

// ─── napcat-parity: get_qun_album_list (QQ NT AlbumService) ───
describe('extended-actions / get_qun_album_list', () => {
  it('forwards the pagination cursor and returns the native AlbumService envelope', async () => {
    const albumList = [{
      album_id: 'a1',
      name: '相册一',
      create_time: '1700000000',
      upload_number: '5',
      creator: { uin: '10001', nick: '😂[em]e328514[/em]' },
    }];
    const listQun = vi.fn(async () => ({
      albumList,
      attachInfo: 'next-cursor',
      hasMore: true,
    }));
    const bridge = fakeBridge({ apis: { groupAlbum: { listQun } } });
    const res = await makeHandler(fakeCtx(bridge)).handle('get_qun_album_list', {
      group_id: 12345,
      attach_info: 'current-cursor',
    });
    expect(listQun).toHaveBeenCalledWith(12345, 'current-cursor');
    expect(res.status).toBe('ok');
    expect(res.data).toEqual({
      album_list: albumList,
      attach_info: 'next-cursor',
      has_more: true,
    });
  });

  it('surfaces failure as a failed response', async () => {
    const listQun = vi.fn(async () => { throw new Error('album service unavailable'); });
    const bridge = fakeBridge({ apis: { groupAlbum: { listQun } } });
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
