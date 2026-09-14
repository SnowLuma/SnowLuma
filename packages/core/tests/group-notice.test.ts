import { describe, expect, it } from 'vitest';
import { mapGroupNoticeResponse } from '../src/bridge/apis/web';
import type { WebApiGroupNoticeFeed, WebApiGroupNoticeRet } from '@snowluma/protocol/web/group-notice';

function feed(fid: string, overrides: Partial<WebApiGroupNoticeFeed> = {}): WebApiGroupNoticeFeed {
  return {
    fid,
    u: 10001,
    pubt: 1_700_000_000,
    msg: { text: `notice-${fid}` },
    settings: {},
    read_num: 2,
    ...overrides,
  };
}

describe('mapGroupNoticeResponse', () => {
  it('merges regular feeds and new-member inst entries with response metadata', () => {
    const ret: WebApiGroupNoticeRet = {
      ec: 0,
      feeds: [feed('regular', {
        type: '6',
        pinned: '1',
        msg: { text: 'regular', pics: [{ id: 'pic', w: '640', h: '360' }] },
      })],
      inst: { welcome: feed('welcome', { settings: { confirm_required: 1 } }) },
    };

    expect(mapGroupNoticeResponse(ret)).toEqual([
      {
        notice_id: 'regular',
        sender_id: 10001,
        publish_time: 1_700_000_000,
        message: {
          text: 'regular',
          image: [{ id: 'pic', width: 640, height: 360 }],
          images: [{ id: 'pic', width: 640, height: 360 }],
        },
        settings: {},
        read_num: 2,
        type: 6,
        pinned: 1,
        send_to_new_members: false,
      },
      {
        notice_id: 'welcome',
        sender_id: 10001,
        publish_time: 1_700_000_000,
        message: { text: 'notice-welcome', image: [], images: [] },
        settings: { confirm_required: 1 },
        read_num: 2,
        type: 20,
        pinned: 0,
        send_to_new_members: true,
      },
    ]);
  });

  it('deduplicates a feed repeated in inst and treats inst as authoritative', () => {
    const duplicate = feed('same', { type: 20 });
    const notices = mapGroupNoticeResponse({ ec: 0, feeds: [duplicate], inst: [duplicate] });

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ notice_id: 'same', send_to_new_members: true, type: 20 });
  });

  it('recognizes a type-20 entry even if QQ places it in feeds', () => {
    expect(mapGroupNoticeResponse({ ec: 0, feeds: [feed('welcome', { type: 20 })] })[0])
      .toMatchObject({ send_to_new_members: true, type: 20 });
  });

  it('surfaces server failures and malformed response fields', () => {
    expect(() => mapGroupNoticeResponse({ ec: 14, em: 'permission denied' })).toThrow('ec=14');
    expect(() => mapGroupNoticeResponse({
      ec: 0,
      feeds: [feed('bad', { msg: { text: 'bad', pics: [{ id: 'x', w: 'wide', h: 20 }] } })],
    })).toThrow('image 0.w');
  });
});
