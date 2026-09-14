import { describe, expect, it } from 'vitest';
import {
  protobuf_encode,
  type bool,
  type pb,
  type pb_repeated,
  type uint_32,
  type uint_64,
} from '@snowluma/proton';
import type { MessageBody } from '@snowluma/proto-defs/message';

import { assertValidMessageElement } from '../../src/element-manifest';
import { decodeRichBody } from '../../src/msg-push/rich-body-decoder';

interface MarkdownFixture {
  content?: pb<1, string>;
  processMsg?: pb<4, string>;
  summary?: pb<5, string>;
  extType?: pb<6, uint_32>;
}

interface KeyboardPermissionFixture {
  type?: pb<1, uint_32>;
  roleIds?: pb_repeated<2, string>;
  userIds?: pb_repeated<3, string>;
}

interface KeyboardActionFixture {
  type?: pb<1, uint_32>;
  permission?: pb<2, KeyboardPermissionFixture>;
  clickLimit?: pb<3, uint_32>;
  unsupportedTips?: pb<4, string>;
  data?: pb<5, string>;
  atBotShowChannelList?: pb<6, bool>;
  reply?: pb<7, bool>;
  enter?: pb<8, bool>;
  anchor?: pb<9, uint_32>;
}

interface KeyboardRenderFixture {
  label?: pb<1, string>;
  visitedLabel?: pb<2, string>;
  style?: pb<3, uint_32>;
}

interface KeyboardButtonFixture {
  id?: pb<1, string>;
  render?: pb<2, KeyboardRenderFixture>;
  action?: pb<3, KeyboardActionFixture>;
}

interface KeyboardRowFixture {
  buttons?: pb_repeated<1, KeyboardButtonFixture>;
}

interface KeyboardFixture {
  rows?: pb_repeated<1, KeyboardRowFixture>;
  botAppid?: pb<2, uint_64>;
}

interface KeyboardExtraFixture {
  keyboard?: pb<1, KeyboardFixture>;
}

function commonBody(serviceType: number, businessType: number, pbElem: Uint8Array): MessageBody {
  return {
    richText: {
      elems: [{ commonElem: { serviceType, businessType, pbElem } } as never],
    },
  };
}

describe('decodeRichBody / bot markdown (#337)', () => {
  it('emits the original markdown and removes its plain-text compatibility sibling', () => {
    const pbElem = protobuf_encode<MarkdownFixture>({
      content: '# Weather\n**Sunny**',
      processMsg: 'Weather: Sunny',
      summary: 'Weather',
      extType: 3,
    });
    const body: MessageBody = {
      richText: {
        elems: [
          { text: { str: 'Weather: Sunny' } } as never,
          { commonElem: { serviceType: 45, businessType: 1, pbElem } } as never,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'markdown', text: '# Weather\n**Sunny**' },
    ]);
  });

  it('decodes the current extended bot-markdown business type', () => {
    const pbElem = protobuf_encode<MarkdownFixture>({ content: '## Agent answer' });
    expect(decodeRichBody(commonBody(45, 4, pbElem), true)).toEqual([
      { type: 'markdown', text: '## Agent answer' },
    ]);
  });

  it('keeps fallback text when the markdown protobuf is malformed', () => {
    const body: MessageBody = {
      richText: {
        elems: [
          { text: { str: 'readable fallback' } } as never,
          {
            commonElem: {
              serviceType: 45,
              businessType: 1,
              pbElem: Uint8Array.of(0x0A, 0x05, 0x41),
            },
          } as never,
        ],
      },
    };

    expect(decodeRichBody(body, true)).toEqual([
      { type: 'text', text: 'readable fallback' },
    ]);
  });
});

describe('decodeRichBody / inline keyboard (#337)', () => {
  const pbElem = protobuf_encode<KeyboardExtraFixture>({
    keyboard: {
      botAppid: 9_007_199_254_740_993n,
      rows: [{
        buttons: [{
          id: 'btn-1',
          render: { label: 'Run', visitedLabel: 'Done', style: 1 },
          action: {
            type: 2,
            permission: { type: 2, roleIds: ['admin'], userIds: ['u_10001'] },
            clickLimit: 3,
            unsupportedTips: 'Admins only',
            data: 'callback-data',
            atBotShowChannelList: true,
            reply: false,
            enter: true,
            anchor: 9,
          },
        }],
      }],
    },
  });

  it.each([46, 50, 51])('decodes service %i business 1 without losing uint64 app id', (serviceType) => {
    const elements = decodeRichBody(commonBody(serviceType, 1, pbElem), true);
    expect(elements).toEqual([{
      type: 'inline_keyboard',
      botAppid: '9007199254740993',
      rows: [{
        buttons: [{
          id: 'btn-1',
          label: 'Run',
          visitedLabel: 'Done',
          style: 1,
          type: 2,
          clickLimit: 3,
          unsupportedTips: 'Admins only',
          data: 'callback-data',
          atBotShowChannelList: true,
          permissionType: 2,
          specifyRoleIds: ['admin'],
          specifyUserIds: ['u_10001'],
          isReply: false,
          enter: true,
          anchor: 9,
        }],
      }],
    }]);
    expect(() => assertValidMessageElement(elements[0], 'D')).not.toThrow();
  });

  it('does not reinterpret an unsupported business type as a keyboard', () => {
    expect(decodeRichBody(commonBody(46, 2, pbElem), true)).toEqual([]);
  });
});
