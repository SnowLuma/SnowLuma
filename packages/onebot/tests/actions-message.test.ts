import { describe, expect, it, vi } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { actions } from '../src/actions/message';
import type { JsonObject, MessageMeta } from '../src/types';

function requireAction(name: string) {
  const action = actions.find((entry) => entry.names[0] === name);
  if (!action) throw new Error(`${name} action missing`);
  return action;
}

function asCtx(partial: Partial<ApiActionContext>): ApiActionContext {
  return partial as ApiActionContext;
}

const sendMsg = requireAction('send_msg');
const sendPrivateMsg = requireAction('send_private_msg');
const sendGroupMsg = requireAction('send_group_msg');
const getMsg = requireAction('get_msg');
const deleteMsg = requireAction('delete_msg');

describe('message actions catalog', () => {
  it('exports the five public message actions in source order', () => {
    expect(actions.map((entry) => entry.names[0])).toEqual([
      'send_msg',
      'send_private_msg',
      'send_group_msg',
      'get_msg',
      'delete_msg',
    ]);
  });

  it('marks only get_msg as read-only', () => {
    expect(sendMsg.describe().readOnly).toBe(false);
    expect(sendPrivateMsg.describe().readOnly).toBe(false);
    expect(sendGroupMsg.describe().readOnly).toBe(false);
    expect(getMsg.describe().readOnly).toBe(true);
    expect(deleteMsg.describe().readOnly).toBe(false);
  });
});

describe('send_msg parse', () => {
  it('defaults auto_escape to false and leaves optional ids unset', () => {
    expect(sendMsg.parse({ message: 'hello route' })).toEqual({
      ok: true,
      value: {
        message: 'hello route',
        message_type: undefined,
        group_id: undefined,
        user_id: undefined,
        auto_escape: false,
      },
    });
  });

  it('parses a JSON-array message string and numeric ids', () => {
    expect(sendMsg.parse({
      message: '[{"type":"text","data":{"text":"hi"}}]',
      message_type: 'group',
      group_id: '314159',
      user_id: '271828',
      auto_escape: 'on',
    })).toEqual({
      ok: true,
      value: {
        message: [{ type: 'text', data: { text: 'hi' } }],
        message_type: 'group',
        group_id: 314159,
        user_id: 271828,
        auto_escape: true,
      },
    });
  });

  it('requires message and rejects group_id 0', () => {
    expect(sendMsg.parse({})).toEqual({
      ok: false,
      field: 'message',
      reason: 'is required',
    });
    expect(sendMsg.parse({ message: 'x', group_id: 0 })).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'must be >= 1',
    });
  });
});

describe('send_msg run', () => {
  it('sends a group message when message_type is group', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 9001 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 0 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      message_type: 'group',
      group_id: 314159,
      message: 'group hello',
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    expect(sendGroupMessage.mock.calls).toEqual([[314159, 'group hello', false]]);
    expect(sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('sends a group message when only group_id is present', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 9002 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 0 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      group_id: 80001,
      user_id: 271828,
      message: [{ type: 'text', data: { text: 'by group_id' } }],
      auto_escape: true,
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9002 } });
    expect(sendGroupMessage.mock.calls).toEqual([[
      80001,
      [{ type: 'text', data: { text: 'by group_id' } }],
      true,
    ]]);
    expect(sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('sends a private message when only user_id is present', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 0 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 9003 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      user_id: 271828,
      message: 'private hello',
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9003 } });
    expect(sendPrivateMessage.mock.calls).toEqual([[271828, 'private hello', false, undefined]]);
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('routes private + both ids into a temp-session reply', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 0 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 9004 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      message_type: 'private',
      user_id: 13579,
      group_id: 70001,
      message: 'temp hi',
      auto_escape: false,
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9004 } });
    expect(sendPrivateMessage.mock.calls).toEqual([[13579, 'temp hi', false, 70001]]);
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it('still sends a group message when message_type is group and user_id is also set', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 9005 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 0 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      message_type: 'group',
      group_id: 80002,
      user_id: 30003,
      message: 'not temp',
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9005 } });
    expect(sendGroupMessage.mock.calls).toEqual([[80002, 'not temp', false]]);
    expect(sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST when message_type is group without group_id', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 0 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 0 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      message_type: 'group',
      message: 'missing group',
    });

    expect(response).toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'group_id is required',
    });
    expect(sendGroupMessage).not.toHaveBeenCalled();
    expect(sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('returns BAD_REQUEST when neither a group route nor user_id is present', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 0 }));
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 0 }));
    const response = await sendMsg.toHandler(asCtx({ sendGroupMessage, sendPrivateMessage }))({
      message_type: 'private',
      message: 'missing user',
    });

    expect(response).toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'user_id is required',
    });
    expect(sendGroupMessage).not.toHaveBeenCalled();
    expect(sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('shapes a parse failure as BAD_REQUEST wording', async () => {
    const response = await sendMsg.toHandler(asCtx({}))({});

    expect(response).toEqual({
      status: 'failed',
      retcode: 1400,
      data: null,
      wording: 'message: is required',
    });
  });
});

describe('send_private_msg', () => {
  it('parses group_id 0 and defaults auto_escape', () => {
    expect(sendPrivateMsg.parse({
      user_id: 24680,
      message: 'plain private',
      group_id: 0,
    })).toEqual({
      ok: true,
      value: {
        user_id: 24680,
        message: 'plain private',
        group_id: 0,
        auto_escape: false,
      },
    });
  });

  it('rejects a negative group_id before sending', () => {
    expect(sendPrivateMsg.parse({
      user_id: 24680,
      message: 'x',
      group_id: -1,
    })).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'must be >= 0',
    });
  });

  it('sends a friend private message when group_id is absent', async () => {
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 9101 }));
    const response = await sendPrivateMsg.toHandler(asCtx({ sendPrivateMessage }))({
      user_id: 24680,
      message: 'friend hi',
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9101 } });
    expect(sendPrivateMessage.mock.calls).toEqual([[24680, 'friend hi', false, undefined]]);
  });

  it('treats group_id 0 as no temp session', async () => {
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 9102 }));
    const response = await sendPrivateMsg.toHandler(asCtx({ sendPrivateMessage }))({
      user_id: 24682,
      group_id: 0,
      message: 'zero group',
      auto_escape: true,
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9102 } });
    expect(sendPrivateMessage.mock.calls).toEqual([[24682, 'zero group', true, undefined]]);
  });

  it('forwards a positive group_id as the temp-session source', async () => {
    const sendPrivateMessage = vi.fn(async () => ({ messageId: 9103 }));
    const response = await sendPrivateMsg.toHandler(asCtx({ sendPrivateMessage }))({
      user_id: 24681,
      group_id: 70002,
      message: 'temp from group',
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9103 } });
    expect(sendPrivateMessage.mock.calls).toEqual([[24681, 'temp from group', false, 70002]]);
  });
});

describe('send_group_msg', () => {
  it('requires group_id from the groupAction preset', () => {
    expect(sendGroupMsg.parse({ message: 'need group' })).toEqual({
      ok: false,
      field: 'group_id',
      reason: 'is required',
    });
    expect(sendGroupMsg.parse({ group_id: 888001, message: 'ok' })).toEqual({
      ok: true,
      value: {
        group_id: 888001,
        message: 'ok',
        auto_escape: false,
      },
    });
  });

  it('sends the group message and returns the receipt id', async () => {
    const sendGroupMessage = vi.fn(async () => ({ messageId: 9201 }));
    const response = await sendGroupMsg.toHandler(asCtx({ sendGroupMessage }))({
      group_id: 888001,
      message: 'group body',
      auto_escape: true,
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: { message_id: 9201 } });
    expect(sendGroupMessage.mock.calls).toEqual([[888001, 'group body', true]]);
  });
});

describe('get_msg', () => {
  it('accepts a negative message_id and rejects 0', () => {
    expect(getMsg.parse({ message_id: -2147483648 })).toEqual({
      ok: true,
      value: { message_id: -2147483648 },
    });
    expect(getMsg.parse({ message_id: 0 })).toEqual({
      ok: false,
      field: 'message_id',
      reason: 'must not be 0',
    });
  });

  it('returns ACTION_FAILED when the store has no event', async () => {
    const getMessage = vi.fn(() => null);
    const response = await getMsg.toHandler(asCtx({ getMessage }))({ message_id: 424243 });

    expect(response).toEqual({
      status: 'failed',
      retcode: 100,
      data: null,
      wording: 'message not found',
    });
    expect(getMessage.mock.calls).toEqual([[424243]]);
  });

  it('strips post_type/self_id and sets real_id from the stored message_id', async () => {
    const stored: JsonObject = {
      post_type: 'message',
      self_id: 10001,
      message_id: 424242,
      message_type: 'group',
      group_id: 314159,
      user_id: 271828,
      message: 'plain stored text',
      time: 1700000000,
    };
    const getMessage = vi.fn(() => stored);
    const getImageInfo = vi.fn(async () => ({ url: 'https://unused.example/img' }));
    const response = await getMsg.toHandler(asCtx({ getMessage, getImageInfo }))({
      message_id: 424242,
    });

    expect(response).toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        message_id: 424242,
        message_type: 'group',
        group_id: 314159,
        user_id: 271828,
        message: 'plain stored text',
        time: 1700000000,
        real_id: 424242,
      },
    });
    expect(stored).toEqual({
      post_type: 'message',
      self_id: 10001,
      message_id: 424242,
      message_type: 'group',
      group_id: 314159,
      user_id: 271828,
      message: 'plain stored text',
      time: 1700000000,
    });
    expect(getImageInfo).not.toHaveBeenCalled();
  });

  it('falls back to the request message_id when the stored event has none', async () => {
    const getMessage = vi.fn(() => ({
      message_type: 'private',
      user_id: 13579,
      message: 'no stored id',
    }));
    const response = await getMsg.toHandler(asCtx({ getMessage }))({ message_id: 555001 });

    expect(response).toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        message_type: 'private',
        user_id: 13579,
        message: 'no stored id',
        real_id: 555001,
      },
    });
  });

  it('refreshes image URLs from file, then file_id, and skips unusable segments', async () => {
    const fileImage: JsonObject = {
      file: 'ABC.jpg',
      file_id: 'SHOULD_NOT_WIN.jpg',
      url: 'https://old.example/ABC.jpg',
    };
    const fileIdImage: JsonObject = {
      file_id: 'BY_FILE_ID.jpg',
      url: 'https://old.example/file-id.jpg',
    };
    const emptyFileImage: JsonObject = {
      file: '',
      file_id: 'SHOULD_NOT_USE.jpg',
      url: 'https://old.example/empty-file.jpg',
    };
    const keepEmptyUrl: JsonObject = {
      file: 'KEEP_EMPTY.jpg',
      url: 'https://old.example/keep-empty.jpg',
    };
    const keepNull: JsonObject = {
      file: 'KEEP_NULL.jpg',
      url: 'https://old.example/keep-null.jpg',
    };
    const keepNonString: JsonObject = {
      file: 'KEEP_NONSTRING.jpg',
      url: 'https://old.example/keep-nonstring.jpg',
    };
    const noHandle: JsonObject = {
      url: 'https://old.example/no-file.jpg',
    };
    const stored: JsonObject = {
      message_id: 777001,
      message: [
        null,
        'skip-me',
        12,
        { type: 'text', data: { text: 'plain' } },
        { type: 'image', data: 'not-object' },
        { type: 'image' },
        { type: 'image', data: emptyFileImage },
        { type: 'image', data: noHandle },
        { type: 'image', data: fileIdImage },
        { type: 'image', data: keepEmptyUrl },
        { type: 'image', data: keepNull },
        { type: 'image', data: keepNonString },
        { type: 'image', data: fileImage },
      ],
    };
    const getImageInfo = vi.fn(async (file: string) => {
      if (file === 'ABC.jpg') return { url: 'https://new.example/ABC.jpg?rkey=FRESH' };
      if (file === 'BY_FILE_ID.jpg') return { url: 'https://new.example/file-id.jpg?rkey=FRESH' };
      if (file === 'KEEP_EMPTY.jpg') return { url: '' };
      if (file === 'KEEP_NULL.jpg') return null;
      if (file === 'KEEP_NONSTRING.jpg') return { url: 1 };
      return { url: 'https://should-not-apply.example/' };
    });

    const response = await getMsg.toHandler(asCtx({
      getMessage: () => stored,
      getImageInfo,
    }))({ message_id: 777001 });

    expect(getImageInfo.mock.calls).toEqual([
      ['BY_FILE_ID.jpg'],
      ['KEEP_EMPTY.jpg'],
      ['KEEP_NULL.jpg'],
      ['KEEP_NONSTRING.jpg'],
      ['ABC.jpg'],
    ]);
    expect(response).toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        message_id: 777001,
        real_id: 777001,
        message: [
          null,
          'skip-me',
          12,
          { type: 'text', data: { text: 'plain' } },
          { type: 'image', data: 'not-object' },
          { type: 'image' },
          { type: 'image', data: emptyFileImage },
          { type: 'image', data: noHandle },
          { type: 'image', data: fileIdImage },
          { type: 'image', data: keepEmptyUrl },
          { type: 'image', data: keepNull },
          { type: 'image', data: keepNonString },
          { type: 'image', data: fileImage },
        ],
      },
    });
    expect(fileImage.url).toBe('https://new.example/ABC.jpg?rkey=FRESH');
    expect(fileIdImage.url).toBe('https://new.example/file-id.jpg?rkey=FRESH');
    expect(emptyFileImage.url).toBe('https://old.example/empty-file.jpg');
    expect(keepEmptyUrl.url).toBe('https://old.example/keep-empty.jpg');
    expect(keepNull.url).toBe('https://old.example/keep-null.jpg');
    expect(keepNonString.url).toBe('https://old.example/keep-nonstring.jpg');
    expect(noHandle.url).toBe('https://old.example/no-file.jpg');
  });

  it('keeps the stored image URL when getImageInfo throws', async () => {
    const imageData: JsonObject = {
      file: 'THROW.jpg',
      url: 'https://old.example/throw.jpg',
    };
    const getImageInfo = vi.fn(async () => {
      throw new Error('rkey fetch failed');
    });
    const response = await getMsg.toHandler(asCtx({
      getMessage: () => ({
        message_id: 777002,
        message: [{ type: 'image', data: imageData }],
      }),
      getImageInfo,
    }))({ message_id: 777002 });

    expect(getImageInfo.mock.calls).toEqual([['THROW.jpg']]);
    expect(response).toEqual({
      status: 'ok',
      retcode: 0,
      data: {
        message_id: 777002,
        real_id: 777002,
        message: [{ type: 'image', data: imageData }],
      },
    });
    expect(imageData.url).toBe('https://old.example/throw.jpg');
  });
});

describe('delete_msg', () => {
  it('returns ACTION_FAILED when no retractable meta exists', async () => {
    const getMessageMeta = vi.fn(() => null);
    const deleteMessage = vi.fn(async () => {});
    const response = await deleteMsg.toHandler(asCtx({ getMessageMeta, deleteMessage }))({
      message_id: 424245,
    });

    expect(response).toEqual({
      status: 'failed',
      retcode: 100,
      data: null,
      wording: 'message not found or not retractable',
    });
    expect(getMessageMeta.mock.calls).toEqual([[424245]]);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('deletes with the stored meta and returns an empty ok payload', async () => {
    const meta: MessageMeta = {
      isGroup: true,
      targetId: 314159,
      sequence: 77,
      sequenceAuthoritative: true,
      eventName: 'group_message',
      clientSequence: 0,
      random: 123,
      timestamp: 1700000000,
    };
    const getMessageMeta = vi.fn(() => meta);
    const deleteMessage = vi.fn(async () => {});
    const response = await deleteMsg.toHandler(asCtx({ getMessageMeta, deleteMessage }))({
      message_id: -424244,
    });

    expect(response).toEqual({ status: 'ok', retcode: 0, data: null });
    expect(getMessageMeta.mock.calls).toEqual([[-424244]]);
    expect(deleteMessage.mock.calls).toEqual([[-424244, meta]]);
  });
});
