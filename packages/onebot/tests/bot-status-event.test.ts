import { describe, expect, it } from 'vitest';
import { convertEvent, type ConverterContext } from '../src/event-converter';
import { makeBotStatusEvent } from '../src/instance';
import type { QQEventVariant } from '@snowluma/protocol/events';

describe('makeBotStatusEvent', () => {
  it('emits a notice with online/offline sub_type and matching ids', () => {
    const online = makeBotStatusEvent(10000, 'online', 1_710_000_000);
    expect(online).toEqual({
      time: 1_710_000_000,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'bot_status',
      sub_type: 'online',
      user_id: 10000,
    });

    const offline = makeBotStatusEvent(10000, 'offline', 1_710_000_001);
    expect(offline.post_type).toBe('notice');
    expect(offline.notice_type).toBe('bot_status');
    expect(offline.sub_type).toBe('offline');
    expect(offline.self_id).toBe(10000);
    expect(offline.user_id).toBe(10000);
  });
});

describe('convertEvent — bot_offline (KickNT)', () => {
  it('keeps notice_type bot_offline with tag and message', async () => {
    const ctx: ConverterContext = {
      selfId: 10001,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      messageIdResolver: null,
      mediaSegmentSink: null,
    };
    const out = await convertEvent(ctx, {
      kind: 'bot_offline',
      time: 1,
      selfUin: 10001,
      tag: '你已离线',
      message: '你的账号在其他设备登录',
    } as QQEventVariant);
    expect(out).toEqual({
      time: 1,
      self_id: 10001,
      post_type: 'notice',
      notice_type: 'bot_offline',
      user_id: 10001,
      tag: '你已离线',
      message: '你的账号在其他设备登录',
    });
  });
});
