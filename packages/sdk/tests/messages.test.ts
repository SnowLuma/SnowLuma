import { describe, expect, it, vi } from 'vitest';
import {
  atAll,
  chain,
  face,
  fromCQString,
  message,
  parseSegments,
  text,
  toCQString,
} from '../src';

describe('MessageChain', () => {
  it.each([false, true])('preserves face animation selection through builders and CQ, large=%s', (large) => {
    const expected = [{ type: 'face', data: { id: '451', large } }];
    const built = face(451, { large });
    expect(built.toSegments()).toEqual(expected);
    expect(chain().face(451, { large }).toSegments()).toEqual(expected);
    expect(message.face(451, { large })).toEqual(expected[0]);
    expect(parseSegments(toCQString(built))).toEqual(expected);
    expect(parseSegments(`[CQ:face,id=451,large=${large ? 1 : 0}]`)).toEqual(expected);
  });

  it('rejects an invalid face animation choice instead of discarding it', () => {
    expect(() => parseSegments('[CQ:face,id=451,large=invalid]')).toThrow('face.large');
  });

  it('builds fluent segment chains', () => {
    const chain = text('hello').at(10001).br().image('/tmp/a.png');

    expect(chain.length).toBe(4);
    expect(chain.toSegments()).toEqual([
      { type: 'text', data: { text: 'hello' } },
      { type: 'at', data: { qq: '10001' } },
      { type: 'text', data: { text: '\n' } },
      { type: 'image', data: { file: '/tmp/a.png' } },
    ]);
  });

  it('keeps the old segment builder API available', () => {
    expect(message.text('hello')).toEqual({ type: 'text', data: { text: 'hello' } });
    expect(atAll().toSegments()).toEqual([{ type: 'at', data: { qq: 'all' } }]);
  });

  it('allows reply only once in a chain at runtime', () => {
    const chain = text('hello').reply(1);
    expect(() => (chain as any).reply(2)).toThrow(/reply/);
    expect(() => chain.append(message.reply(2))).toThrow(/reply/);
  });

  it('appends other messages and converts to CQ string', () => {
    const chain = text('hello').append([message.at('all'), message.face(14)]);
    expect(toCQString(chain)).toBe('hello[CQ:at,qq=all][CQ:face,id=14]');
  });

  it('parses CQ strings into chains', () => {
    const chain = fromCQString('hi[CQ:at,qq=all][CQ:image,file=a&#44;b]');
    expect(chain.toSegments()).toEqual([
      { type: 'text', data: { text: 'hi' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'image', data: { file: 'a,b', url: undefined, type: undefined, summary: undefined } },
    ]);
    expect(parseSegments('[CQ:reply,id=7]')).toEqual([{ type: 'reply', data: { id: '7' } }]);
  });

  it('can send itself through a compatible client', async () => {
    const client = {
      sendGroupMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendPrivateMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
    };

    await text('hi').sendToGroup(client, 123);
    await text('yo').sendToPrivate(client, 456);

    expect(client.sendGroupMessage).toHaveBeenCalledWith(123, text('hi'), undefined);
    expect(client.sendPrivateMessage).toHaveBeenCalledWith(456, text('yo'), undefined);
  });
});
