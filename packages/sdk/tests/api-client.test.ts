import { describe, expect, it } from 'vitest';
import { SnowLumaApiClient, toJsonObject } from '../src/client/api-client';
import {
  SnowLumaApiError,
  SnowLumaAuthError,
  text,
  type ActionParams,
  type ActionResult,
  type ApiResponse,
  type RequestOptions,
  type SnowLumaAction,
} from '../src';

class RecordingClient extends SnowLumaApiClient {
  readonly calls: Array<{
    action: string;
    params: unknown;
    options: RequestOptions | undefined;
  }> = [];

  response: ApiResponse = { status: 'ok', retcode: 0, data: null };

  async request<TAction extends SnowLumaAction>(
    action: TAction,
    params?: ActionParams<TAction>,
    options?: RequestOptions,
  ): Promise<ApiResponse<ActionResult<TAction>>> {
    this.calls.push({ action, params, options });
    return this.response as ApiResponse<ActionResult<TAction>>;
  }
}

function okClient(data: unknown = null): RecordingClient {
  const client = new RecordingClient();
  client.response = { status: 'ok', retcode: 0, data };
  return client;
}

describe('toJsonObject', () => {
  it('returns an empty object for undefined', () => {
    expect(toJsonObject(undefined)).toEqual({});
  });

  it('returns the same object when one is provided', () => {
    const value = { domain: 'qun.qq.com' };
    expect(toJsonObject(value)).toBe(value);
  });
});

describe('SnowLumaApiClient.call', () => {
  it('returns response data when status is ok and retcode is 0', async () => {
    const client = okClient({ user_id: 1787882683, nickname: 'luma' });

    await expect(client.call('get_login_info', {}, { timeoutMs: 1500 })).resolves.toEqual({
      user_id: 1787882683,
      nickname: 'luma',
    });
    expect(client.calls).toEqual([
      { action: 'get_login_info', params: {}, options: { timeoutMs: 1500 } },
    ]);
  });

  it('throws SnowLumaApiError when status is failed even if retcode is 0', async () => {
    const client = new RecordingClient();
    const response: ApiResponse = {
      status: 'failed',
      retcode: 0,
      data: null,
      wording: 'handler rejected',
    };
    client.response = response;

    await expect(client.call('clean_cache', {})).rejects.toBeInstanceOf(SnowLumaApiError);
    await expect(client.call('clean_cache', {})).rejects.toMatchObject({
      name: 'SnowLumaApiError',
      retcode: 0,
      wording: 'handler rejected',
      message: 'handler rejected',
      response,
    });
  });

  it('throws SnowLumaApiError when retcode is non-zero even if status is ok', async () => {
    const client = new RecordingClient();
    const response: ApiResponse = { status: 'ok', retcode: 1200, data: null };
    client.response = response;

    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaApiError);
    await expect(client.getStatus()).rejects.toMatchObject({
      name: 'SnowLumaApiError',
      retcode: 1200,
      message: 'SnowLuma API failed with retcode 1200',
      response,
    });
  });

  it('throws SnowLumaAuthError for auth retcodes', async () => {
    const client = new RecordingClient();

    client.response = { status: 'failed', retcode: 1401, data: null, wording: 'unauthorized' };
    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaAuthError);

    client.response = { status: 'ok', retcode: 401, data: null, wording: 'token missing' };
    await expect(client.getStatus()).rejects.toMatchObject({
      name: 'SnowLumaAuthError',
      retcode: 401,
      wording: 'token missing',
    });

    client.response = { status: 'failed', retcode: 403, data: null };
    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaAuthError);
  });
});

describe('SnowLumaApiClient.raw', () => {
  it('unwraps successful data and forwards the raw action arguments', async () => {
    const client = okClient({ cookies: 'uin=o10001' });

    await expect(client.raw('get_cookies', { domain: 'qun.qq.com' }, { echo: 'raw-1' })).resolves.toEqual({
      cookies: 'uin=o10001',
    });
    expect(client.calls).toEqual([
      { action: 'get_cookies', params: { domain: 'qun.qq.com' }, options: { echo: 'raw-1' } },
    ]);
  });

  it('throws on failed envelopes instead of returning them', async () => {
    const client = new RecordingClient();
    client.response = { status: 'failed', retcode: 1403, data: null, wording: 'denied' };

    await expect(client.raw('get_csrf_token', {})).rejects.toBeInstanceOf(SnowLumaApiError);
  });
});

describe('SnowLumaApiClient.rawResponse', () => {
  it('returns the full envelope without applying call error handling', async () => {
    const client = new RecordingClient();
    const response: ApiResponse = { status: 'failed', retcode: 1403, data: null, wording: 'denied' };
    client.response = response;

    await expect(client.rawResponse('get_csrf_token', {}, { echo: 'env-1' })).resolves.toEqual(response);
    expect(client.calls).toEqual([
      { action: 'get_csrf_token', params: {}, options: { echo: 'env-1' } },
    ]);
  });
});

describe('SnowLumaApiClient typed actions', () => {
  it('maps session helpers to empty-param OneBot actions', async () => {
    const client = okClient();
    const timeout = { timeoutMs: 2500 };

    await client.getLoginInfo();
    await client.getStatus(timeout);
    await client.getVersionInfo();
    await client.canSendImage();
    await client.canSendRecord();
    await client.getFriendList();
    await client.getRKey();
    await client.getCsrfToken();
    await client.cleanCache();
    await client.markAllAsRead();
    await client.checkUrlSafely();
    await client.getClientKey();

    expect(client.calls).toEqual([
      { action: 'get_login_info', params: {}, options: undefined },
      { action: 'get_status', params: {}, options: timeout },
      { action: 'get_version_info', params: {}, options: undefined },
      { action: 'can_send_image', params: {}, options: undefined },
      { action: 'can_send_record', params: {}, options: undefined },
      { action: 'get_friend_list', params: {}, options: undefined },
      { action: 'get_rkey', params: {}, options: undefined },
      { action: 'get_csrf_token', params: {}, options: undefined },
      { action: 'clean_cache', params: {}, options: undefined },
      { action: '_mark_all_as_read', params: {}, options: undefined },
      { action: 'check_url_safely', params: {}, options: undefined },
      { action: 'get_clientkey', params: {}, options: undefined },
    ]);
  });

  it('normalizes outgoing messages for send helpers', async () => {
    const client = okClient({ message_id: 88 });

    await client.sendMsg({
      message_type: 'group',
      group_id: 941657197,
      message: 'plain',
      auto_escape: true,
    });
    await client.sendMsg({
      message_type: 'private',
      user_id: 10001,
      message: { type: 'text', data: { text: 'seg' } },
    });
    await client.sendPrivateMessage(10002, text('hi'), { autoEscape: true, timeoutMs: 9 });
    await client.sendGroupMessage(20002, [{ type: 'text', data: { text: 'arr' } }]);
    await client.sendGroupForwardMessage(30003, text('fwd-g'));
    await client.sendPrivateForwardMessage(40004, 'fwd-p');

    expect(client.calls).toEqual([
      {
        action: 'send_msg',
        params: {
          message_type: 'group',
          group_id: 941657197,
          message: 'plain',
          auto_escape: true,
        },
        options: undefined,
      },
      {
        action: 'send_msg',
        params: {
          message_type: 'private',
          user_id: 10001,
          message: [{ type: 'text', data: { text: 'seg' } }],
        },
        options: undefined,
      },
      {
        action: 'send_private_msg',
        params: {
          user_id: 10002,
          message: [{ type: 'text', data: { text: 'hi' } }],
          auto_escape: true,
        },
        options: { autoEscape: true, timeoutMs: 9 },
      },
      {
        action: 'send_group_msg',
        params: {
          group_id: 20002,
          message: [{ type: 'text', data: { text: 'arr' } }],
          auto_escape: undefined,
        },
        options: undefined,
      },
      {
        action: 'send_group_forward_msg',
        params: {
          group_id: 30003,
          messages: [{ type: 'text', data: { text: 'fwd-g' } }],
        },
        options: undefined,
      },
      {
        action: 'send_private_forward_msg',
        params: {
          user_id: 40004,
          messages: 'fwd-p',
        },
        options: undefined,
      },
    ]);
  });

  it('maps message lookup, delete, and history helpers', async () => {
    const client = okClient();

    await client.getMessage(71);
    await client.deleteMessage(72);
    await client.getGroupMessageHistory({ group_id: 941657197, message_id: 73, count: 20, reverse_order: false });
    await client.getFriendMessageHistory({ user_id: 10001, count: 8 });
    await client.markGroupMessageAsRead(74);
    await client.markGroupMessageAsRead(75, 941657198);
    await client.markPrivateMessageAsRead(76);
    await client.markPrivateMessageAsRead(77, 10002);
    await client.markMessageAsRead(78);
    await client.markMessageAsRead(79, 10003);

    expect(client.calls).toEqual([
      { action: 'get_msg', params: { message_id: 71 }, options: undefined },
      { action: 'delete_msg', params: { message_id: 72 }, options: undefined },
      {
        action: 'get_group_msg_history',
        params: { group_id: 941657197, message_id: 73, count: 20, reverse_order: false },
        options: undefined,
      },
      {
        action: 'get_friend_msg_history',
        params: { user_id: 10001, count: 8 },
        options: undefined,
      },
      { action: 'mark_group_msg_as_read', params: { message_id: 74, group_id: undefined }, options: undefined },
      { action: 'mark_group_msg_as_read', params: { message_id: 75, group_id: 941657198 }, options: undefined },
      { action: 'mark_private_msg_as_read', params: { message_id: 76, user_id: undefined }, options: undefined },
      { action: 'mark_private_msg_as_read', params: { message_id: 77, user_id: 10002 }, options: undefined },
      { action: 'mark_msg_as_read', params: { message_id: 78, target_id: undefined }, options: undefined },
      { action: 'mark_msg_as_read', params: { message_id: 79, target_id: 10003 }, options: undefined },
    ]);
  });

  it('maps friend and stranger helpers, including optional block', async () => {
    const client = okClient();

    await client.getStrangerInfo(10011);
    await client.deleteFriend(10012);
    await client.deleteFriend(10013, { block: true, timeoutMs: 40 });
    await client.setFriendRemark(10014, 'alias');
    await client.setFriendAddRequest('flag-a');
    await client.setFriendAddRequest('flag-b', false);

    expect(client.calls).toEqual([
      { action: 'get_stranger_info', params: { user_id: 10011 }, options: undefined },
      { action: 'delete_friend', params: { user_id: 10012, block: undefined }, options: undefined },
      { action: 'delete_friend', params: { user_id: 10013, block: true }, options: { block: true, timeoutMs: 40 } },
      { action: 'set_friend_remark', params: { user_id: 10014, remark: 'alias' }, options: undefined },
      { action: 'set_friend_add_request', params: { flag: 'flag-a', approve: true }, options: undefined },
      { action: 'set_friend_add_request', params: { flag: 'flag-b', approve: false }, options: undefined },
    ]);
  });

  it('maps group list and member lookups with noCache', async () => {
    const client = okClient();

    await client.getGroupList();
    await client.getGroupList({ noCache: true, timeoutMs: 11 });
    await client.getGroupInfo(941657197);
    await client.getGroupInfo(941657198, { noCache: false });
    await client.getGroupMemberList(941657199);
    await client.getGroupMemberList(941657200, { noCache: true });
    await client.getGroupMemberInfo(941657201, 10021);
    await client.getGroupMemberInfo(941657202, 10022, { noCache: true });
    await client.getGroupInfoEx(941657203);
    await client.getGroupInfoEx(941657204, { noCache: true });
    await client.getGroupDetailInfo(941657205);
    await client.getGroupDetailInfo(941657206, { noCache: true });

    expect(client.calls).toEqual([
      { action: 'get_group_list', params: { no_cache: undefined }, options: undefined },
      { action: 'get_group_list', params: { no_cache: true }, options: { noCache: true, timeoutMs: 11 } },
      { action: 'get_group_info', params: { group_id: 941657197, no_cache: undefined }, options: undefined },
      { action: 'get_group_info', params: { group_id: 941657198, no_cache: false }, options: { noCache: false } },
      { action: 'get_group_member_list', params: { group_id: 941657199, no_cache: undefined }, options: undefined },
      { action: 'get_group_member_list', params: { group_id: 941657200, no_cache: true }, options: { noCache: true } },
      {
        action: 'get_group_member_info',
        params: { group_id: 941657201, user_id: 10021, no_cache: undefined },
        options: undefined,
      },
      {
        action: 'get_group_member_info',
        params: { group_id: 941657202, user_id: 10022, no_cache: true },
        options: { noCache: true },
      },
      { action: 'get_group_info_ex', params: { group_id: 941657203, no_cache: undefined }, options: undefined },
      { action: 'get_group_info_ex', params: { group_id: 941657204, no_cache: true }, options: { noCache: true } },
      { action: 'get_group_detail_info', params: { group_id: 941657205, no_cache: undefined }, options: undefined },
      { action: 'get_group_detail_info', params: { group_id: 941657206, no_cache: true }, options: { noCache: true } },
    ]);
  });

  it('maps honor and system-message helpers', async () => {
    const client = okClient();

    await client.getGroupHonorInfo({ group_id: 941657210, type: 'talkative' });
    await client.getGroupSystemMessages();
    await client.getGroupSystemMessages({ groupId: 941657211, onlyPending: true, count: 5 });

    expect(client.calls).toEqual([
      { action: 'get_group_honor_info', params: { group_id: 941657210, type: 'talkative' }, options: undefined },
      {
        action: 'get_group_system_msg',
        params: { group_id: undefined, only_pending: undefined, count: undefined },
        options: undefined,
      },
      {
        action: 'get_group_system_msg',
        params: { group_id: 941657211, only_pending: true, count: 5 },
        options: { groupId: 941657211, onlyPending: true, count: 5 },
      },
    ]);
  });

  it('maps group administration helpers and their defaults', async () => {
    const client = okClient();

    await client.setGroupKick(941657220, 10031);
    await client.setGroupKick(941657221, 10032, { rejectAddRequest: true });
    await client.setGroupBan(941657222, 10033);
    await client.setGroupBan(941657223, 10034, 600);
    await client.setGroupWholeBan(941657224);
    await client.setGroupWholeBan(941657225, false);
    await client.setGroupAdmin(941657226, 10035);
    await client.setGroupAdmin(941657227, 10036, false);
    await client.setGroupCard(941657228, 10037);
    await client.setGroupCard(941657229, 10038, 'card');
    await client.setGroupName(941657230, 'new-name');
    await client.setGroupLeave(941657231);
    await client.setGroupSpecialTitle(941657232, 10039);
    await client.setGroupSpecialTitle(941657233, 10040, 'title');

    expect(client.calls).toEqual([
      {
        action: 'set_group_kick',
        params: { group_id: 941657220, user_id: 10031, reject_add_request: undefined },
        options: undefined,
      },
      {
        action: 'set_group_kick',
        params: { group_id: 941657221, user_id: 10032, reject_add_request: true },
        options: { rejectAddRequest: true },
      },
      { action: 'set_group_ban', params: { group_id: 941657222, user_id: 10033, duration: undefined }, options: undefined },
      { action: 'set_group_ban', params: { group_id: 941657223, user_id: 10034, duration: 600 }, options: undefined },
      { action: 'set_group_whole_ban', params: { group_id: 941657224, enable: true }, options: undefined },
      { action: 'set_group_whole_ban', params: { group_id: 941657225, enable: false }, options: undefined },
      { action: 'set_group_admin', params: { group_id: 941657226, user_id: 10035, enable: true }, options: undefined },
      { action: 'set_group_admin', params: { group_id: 941657227, user_id: 10036, enable: false }, options: undefined },
      { action: 'set_group_card', params: { group_id: 941657228, user_id: 10037, card: '' }, options: undefined },
      { action: 'set_group_card', params: { group_id: 941657229, user_id: 10038, card: 'card' }, options: undefined },
      { action: 'set_group_name', params: { group_id: 941657230, group_name: 'new-name' }, options: undefined },
      { action: 'set_group_leave', params: { group_id: 941657231 }, options: undefined },
      {
        action: 'set_group_special_title',
        params: { group_id: 941657232, user_id: 10039, special_title: '' },
        options: undefined,
      },
      {
        action: 'set_group_special_title',
        params: { group_id: 941657233, user_id: 10040, special_title: 'title' },
        options: undefined,
      },
    ]);
  });

  it('maps group and private file helpers', async () => {
    const client = okClient();

    await client.uploadGroupFile(941657240, '/tmp/a.png');
    await client.uploadGroupFile(941657241, '/tmp/b.png', {
      name: 'b.png',
      folder: '/docs',
      folderId: '/abc',
      uploadFile: true,
    });
    await client.uploadPrivateFile(10051, '/tmp/c.png');
    await client.uploadPrivateFile(10052, '/tmp/d.png', { name: 'd.png', uploadFile: false });
    await client.getGroupFileUrl(941657242, 'file-1');
    await client.getGroupFileUrl(941657243, 'file-2', { busid: 102 });
    await client.getGroupRootFiles(941657244);
    await client.getGroupFilesByFolder(941657245);
    await client.getGroupFilesByFolder(941657246, '/sub');
    await client.deleteGroupFile(941657247, 'file-3');
    await client.moveGroupFile(941657248, 'file-4', '/from', '/to');
    await client.createGroupFileFolder(941657249, 'photos');
    await client.createGroupFileFolder(941657250, 'docs', '/root');
    await client.deleteGroupFileFolder(941657251, '/gone');
    await client.renameGroupFileFolder(941657252, '/old', 'new-name');
    await client.getPrivateFileUrl(10053, 'file-5', 'hash-5');
    await client.getGroupFileSystemInfo(941657253);

    expect(client.calls).toEqual([
      {
        action: 'upload_group_file',
        params: {
          group_id: 941657240,
          file: '/tmp/a.png',
          name: undefined,
          folder: undefined,
          folder_id: undefined,
          upload_file: undefined,
        },
        options: {},
      },
      {
        action: 'upload_group_file',
        params: {
          group_id: 941657241,
          file: '/tmp/b.png',
          name: 'b.png',
          folder: '/docs',
          folder_id: '/abc',
          upload_file: true,
        },
        options: { name: 'b.png', folder: '/docs', folderId: '/abc', uploadFile: true },
      },
      {
        action: 'upload_private_file',
        params: { user_id: 10051, file: '/tmp/c.png', name: undefined, upload_file: undefined },
        options: {},
      },
      {
        action: 'upload_private_file',
        params: { user_id: 10052, file: '/tmp/d.png', name: 'd.png', upload_file: false },
        options: { name: 'd.png', uploadFile: false },
      },
      { action: 'get_group_file_url', params: { group_id: 941657242, file_id: 'file-1', busid: undefined }, options: undefined },
      { action: 'get_group_file_url', params: { group_id: 941657243, file_id: 'file-2', busid: 102 }, options: { busid: 102 } },
      { action: 'get_group_root_files', params: { group_id: 941657244 }, options: undefined },
      { action: 'get_group_files_by_folder', params: { group_id: 941657245, folder_id: '/' }, options: undefined },
      { action: 'get_group_files_by_folder', params: { group_id: 941657246, folder_id: '/sub' }, options: undefined },
      { action: 'delete_group_file', params: { group_id: 941657247, file_id: 'file-3' }, options: undefined },
      {
        action: 'move_group_file',
        params: {
          group_id: 941657248,
          file_id: 'file-4',
          parent_directory: '/from',
          target_directory: '/to',
        },
        options: undefined,
      },
      { action: 'create_group_file_folder', params: { group_id: 941657249, name: 'photos', parent_id: '/' }, options: undefined },
      { action: 'create_group_file_folder', params: { group_id: 941657250, name: 'docs', parent_id: '/root' }, options: undefined },
      { action: 'delete_group_file_folder', params: { group_id: 941657251, folder_id: '/gone' }, options: undefined },
      {
        action: 'rename_group_file_folder',
        params: { group_id: 941657252, folder_id: '/old', new_folder_name: 'new-name' },
        options: undefined,
      },
      { action: 'get_private_file_url', params: { user_id: 10053, file_id: 'file-5', file_hash: 'hash-5' }, options: undefined },
      { action: 'get_group_file_system_info', params: { group_id: 941657253 }, options: undefined },
    ]);
  });

  it('maps group add-request, poke, like, and essence helpers', async () => {
    const client = okClient();

    await client.setGroupAddRequest('flag-c');
    await client.setGroupAddRequest('flag-d', {
      subType: 'add',
      type: 'group',
      approve: false,
      reason: 'nope',
    });
    await client.sendLike(10061);
    await client.sendLike(10062, 5);
    await client.friendPoke(10063);
    await client.friendPoke(10064, { targetId: 10065 });
    await client.groupPoke(941657260, 10066);
    await client.sendPoke(10067);
    await client.sendPoke(10068, { groupId: 941657261 });
    await client.setEssenceMessage(81);
    await client.deleteEssenceMessage(82);
    await client.getEssenceMessageList(941657262);
    await client.setGroupReaction({ message_id: 83, code: '76', group_id: 941657263, is_set: true });

    expect(client.calls).toEqual([
      {
        action: 'set_group_add_request',
        params: { flag: 'flag-c', sub_type: undefined, type: undefined, approve: undefined, reason: undefined },
        options: {},
      },
      {
        action: 'set_group_add_request',
        params: { flag: 'flag-d', sub_type: 'add', type: 'group', approve: false, reason: 'nope' },
        options: { subType: 'add', type: 'group', approve: false, reason: 'nope' },
      },
      { action: 'send_like', params: { user_id: 10061, times: 1 }, options: undefined },
      { action: 'send_like', params: { user_id: 10062, times: 5 }, options: undefined },
      { action: 'friend_poke', params: { user_id: 10063, target_id: undefined }, options: undefined },
      { action: 'friend_poke', params: { user_id: 10064, target_id: 10065 }, options: { targetId: 10065 } },
      { action: 'group_poke', params: { group_id: 941657260, user_id: 10066 }, options: undefined },
      { action: 'send_poke', params: { user_id: 10067, group_id: undefined }, options: undefined },
      { action: 'send_poke', params: { user_id: 10068, group_id: 941657261 }, options: { groupId: 941657261 } },
      { action: 'set_essence_msg', params: { message_id: 81 }, options: undefined },
      { action: 'delete_essence_msg', params: { message_id: 82 }, options: undefined },
      { action: 'get_essence_msg_list', params: { group_id: 941657262 }, options: undefined },
      {
        action: 'set_group_reaction',
        params: { message_id: 83, code: '76', group_id: 941657263, is_set: true },
        options: undefined,
      },
    ]);
  });

  it('maps group-notice helpers to underscored OneBot actions', async () => {
    const client = okClient();

    await client.sendGroupNotice(941657270, 'welcome');
    await client.sendGroupNotice(941657271, 'pinned', {
      image: 'https://example.test/n.png',
      pinned: 1,
      type: 20,
      sendToNewMembers: true,
      isShowEditCard: 0,
      tipWindowType: 1,
      confirmRequired: 0,
    });
    await client.getGroupNotice(941657272);

    expect(client.calls).toEqual([
      {
        action: '_send_group_notice',
        params: {
          group_id: 941657270,
          content: 'welcome',
          image: undefined,
          pinned: undefined,
          type: undefined,
          send_to_new_members: undefined,
          is_show_edit_card: undefined,
          tip_window_type: undefined,
          confirm_required: undefined,
        },
        options: {},
      },
      {
        action: '_send_group_notice',
        params: {
          group_id: 941657271,
          content: 'pinned',
          image: 'https://example.test/n.png',
          pinned: 1,
          type: 20,
          send_to_new_members: true,
          is_show_edit_card: 0,
          tip_window_type: 1,
          confirm_required: 0,
        },
        options: {
          image: 'https://example.test/n.png',
          pinned: 1,
          type: 20,
          sendToNewMembers: true,
          isShowEditCard: 0,
          tipWindowType: 1,
          confirmRequired: 0,
        },
      },
      { action: '_get_group_notice', params: { group_id: 941657272 }, options: undefined },
    ]);
  });

  it('forwards forward-message and media helpers without remapping their params', async () => {
    const client = okClient();

    await client.uploadForwardMessage({ group_id: 941657280, messages: 'up' });
    await client.sendForwardMessage({ user_id: 10071, message: 'send' });
    await client.getForwardMessage({ id: 'fwd-1' });
    await client.getImage({ file: 'img-1' });
    await client.getRecord({ file_id: 'rec-1' });
    await client.downloadFile({ url: 'https://example.test/a.bin', name: 'a.bin' });

    expect(client.calls).toEqual([
      { action: 'upload_forward_msg', params: { group_id: 941657280, messages: 'up' }, options: undefined },
      { action: 'send_forward_msg', params: { user_id: 10071, message: 'send' }, options: undefined },
      { action: 'get_forward_msg', params: { id: 'fwd-1' }, options: undefined },
      { action: 'get_image', params: { file: 'img-1' }, options: undefined },
      { action: 'get_record', params: { file_id: 'rec-1' }, options: undefined },
      { action: 'download_file', params: { url: 'https://example.test/a.bin', name: 'a.bin' }, options: undefined },
    ]);
  });

  it('maps cookie, credential, profile, and status helpers', async () => {
    const client = okClient();

    await client.getCookies();
    await client.getCookies({ domain: 'qun.qq.com' });
    await client.getCredentials();
    await client.getCredentials({ domain: 'qzone.qq.com' });
    await client.setQqProfile({ nickname: 'luma', personalNote: 'hello' });
    await client.setOnlineStatus(11);
    await client.setOnlineStatus(10, { extStatus: 1000, batteryStatus: 80, timeoutMs: 30 });

    expect(client.calls).toEqual([
      { action: 'get_cookies', params: {}, options: undefined },
      { action: 'get_cookies', params: { domain: 'qun.qq.com' }, options: undefined },
      { action: 'get_credentials', params: {}, options: undefined },
      { action: 'get_credentials', params: { domain: 'qzone.qq.com' }, options: undefined },
      { action: 'set_qq_profile', params: { nickname: 'luma', personal_note: 'hello' }, options: undefined },
      { action: 'set_online_status', params: { status: 11, ext_status: undefined, battery_status: undefined }, options: {} },
      {
        action: 'set_online_status',
        params: { status: 10, ext_status: 1000, battery_status: 80 },
        options: { extStatus: 1000, batteryStatus: 80, timeoutMs: 30 },
      },
    ]);
  });

  it('maps emoji and system-face helpers including refresh defaults', async () => {
    const client = okClient();

    await client.setMsgEmojiLike(91, '128076');
    await client.setMsgEmojiLike(92, '128077', false);
    await client.fetchSysFaces();
    await client.fetchSysFaces(true);
    await client.fetchFaceEntity(392);
    await client.fetchFaceEntity(393, { refresh: true });
    await client.searchSysFaces('dragon');
    await client.fetchSuperFaceId(394);
    await client.fetchSuperFaceId(395, { refresh: false });

    expect(client.calls).toEqual([
      { action: 'set_msg_emoji_like', params: { message_id: 91, emoji_id: '128076', set: true }, options: undefined },
      { action: 'set_msg_emoji_like', params: { message_id: 92, emoji_id: '128077', set: false }, options: undefined },
      { action: 'fetch_sys_faces', params: { refresh: false }, options: undefined },
      { action: 'fetch_sys_faces', params: { refresh: true }, options: undefined },
      { action: 'fetch_face_entity', params: { face_id: 392, refresh: false }, options: {} },
      { action: 'fetch_face_entity', params: { face_id: 393, refresh: true }, options: { refresh: true } },
      { action: 'search_sys_faces', params: { query: 'dragon' }, options: undefined },
      { action: 'fetch_super_face_id', params: { face_id: 394, refresh: false }, options: {} },
      { action: 'fetch_super_face_id', params: { face_id: 395, refresh: false }, options: { refresh: false } },
    ]);
  });
});
