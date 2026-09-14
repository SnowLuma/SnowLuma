import { describe, expect, it, vi } from 'vitest';
import {
  at,
  atAll,
  br,
  chain,
  contact,
  face,
  forward,
  image,
  json,
  location,
  MessageChain,
  music,
  node,
  normalizeMessage,
  poke,
  raw,
  record,
  reply,
  share,
  text,
  video,
  xml,
} from '../src';

function sender() {
  return {
    sendGroupMessage: vi.fn().mockResolvedValue({ message_id: 61001 }),
    sendPrivateMessage: vi.fn().mockResolvedValue({ message_id: 61002 }),
  };
}

describe('MessageChain.empty and chain()', () => {
  it('starts empty', () => {
    const empty = MessageChain.empty();

    expect(empty).toBeInstanceOf(MessageChain);
    expect(empty.length).toBe(0);
    expect(empty.isEmpty).toBe(true);
    expect(empty.toSegments()).toEqual([]);
    expect(chain().toSegments()).toEqual([]);
  });

  it('updates length and isEmpty after a segment is added', () => {
    const next = chain().text('wave');

    expect(next.length).toBe(1);
    expect(next.isEmpty).toBe(false);
    expect(chain().isEmpty).toBe(true);
  });

  it('does not mutate the previous chain when a segment is added', () => {
    const base = text('keep');
    const next = base.face(39);

    expect(base.toSegments()).toEqual([{ type: 'text', data: { text: 'keep' } }]);
    expect(next.toSegments()).toEqual([
      { type: 'text', data: { text: 'keep' } },
      { type: 'face', data: { id: '39' } },
    ]);
  });
});

describe('segment builders', () => {
  it('builds a text segment and defaults to an empty string', () => {
    expect(text().toSegments()).toEqual([{ type: 'text', data: { text: '' } }]);
    expect(text('wave').toSegments()).toEqual([{ type: 'text', data: { text: 'wave' } }]);
    expect(chain().text().toSegments()).toEqual([{ type: 'text', data: { text: '' } }]);
  });

  it('treats br as a newline text segment', () => {
    expect(br().toSegments()).toEqual([{ type: 'text', data: { text: '\n' } }]);
  });

  it('stringifies face ids', () => {
    expect(face(39).toSegments()).toEqual([{ type: 'face', data: { id: '39' } }]);
    expect(face('178').toSegments()).toEqual([{ type: 'face', data: { id: '178' } }]);
  });

  it('stringifies at targets and only copies truthy name/uid', () => {
    expect(at(31415).toSegments()).toEqual([{ type: 'at', data: { qq: '31415' } }]);
    expect(at('all').toSegments()).toEqual([{ type: 'at', data: { qq: 'all' } }]);
    expect(atAll().toSegments()).toEqual([{ type: 'at', data: { qq: 'all' } }]);
    expect(at(31415, { name: 'Ada', uid: 'uid-ada' }).toSegments()).toEqual([
      { type: 'at', data: { qq: '31415', name: 'Ada', uid: 'uid-ada' } },
    ]);
    expect(at(31415, { name: '', uid: '' }).toSegments()).toEqual([
      { type: 'at', data: { qq: '31415' } },
    ]);
  });

  it('stringifies reply ids', () => {
    expect(reply(88).toSegments()).toEqual([{ type: 'reply', data: { id: '88' } }]);
    expect(reply('mid-88').toSegments()).toEqual([{ type: 'reply', data: { id: 'mid-88' } }]);
  });

  it('spreads image, record, and video options after file', () => {
    expect(image('file://pic.webp').toSegments()).toEqual([
      { type: 'image', data: { file: 'file://pic.webp' } },
    ]);
    expect(
      image('file://pic.webp', {
        type: 'flash',
        subType: 4,
        summary: 'cover',
        url: 'https://cdn.example/pic.webp',
      }).toSegments(),
    ).toEqual([
      {
        type: 'image',
        data: {
          file: 'file://pic.webp',
          type: 'flash',
          subType: 4,
          summary: 'cover',
          url: 'https://cdn.example/pic.webp',
        },
      },
    ]);
    expect(record('file://voice.amr').toSegments()).toEqual([
      { type: 'record', data: { file: 'file://voice.amr' } },
    ]);
    expect(record('file://voice.amr', { url: 'https://cdn.example/voice.amr' }).toSegments()).toEqual([
      { type: 'record', data: { file: 'file://voice.amr', url: 'https://cdn.example/voice.amr' } },
    ]);
    expect(video('file://clip.mp4').toSegments()).toEqual([
      { type: 'video', data: { file: 'file://clip.mp4' } },
    ]);
    expect(
      video('file://clip.mp4', {
        url: 'https://cdn.example/clip.mp4',
        thumb: 'file://thumb.jpg',
      }).toSegments(),
    ).toEqual([
      {
        type: 'video',
        data: {
          file: 'file://clip.mp4',
          url: 'https://cdn.example/clip.mp4',
          thumb: 'file://thumb.jpg',
        },
      },
    ]);
  });

  it('keeps a json string and stringifies a json object', () => {
    expect(json('{"prompt":"card"}').toSegments()).toEqual([
      { type: 'json', data: { data: '{"prompt":"card"}' } },
    ]);
    expect(json({ prompt: 'card', n: 2 }).toSegments()).toEqual([
      { type: 'json', data: { data: '{"prompt":"card","n":2}' } },
    ]);
  });

  it('spreads xml options after the payload', () => {
    expect(xml('<item />').toSegments()).toEqual([{ type: 'xml', data: { data: '<item />' } }]);
    expect(xml('<item />', { id: 'resid-3' }).toSegments()).toEqual([
      { type: 'xml', data: { data: '<item />', id: 'resid-3' } },
    ]);
  });

  it('omits poke id only when it is undefined', () => {
    expect(poke(6).toSegments()).toEqual([{ type: 'poke', data: { type: 6 } }]);
    expect(poke(6, 0).toSegments()).toEqual([{ type: 'poke', data: { type: 6, id: 0 } }]);
    expect(poke('6', '-1').toSegments()).toEqual([{ type: 'poke', data: { type: '6', id: '-1' } }]);
  });

  it('mirrors a forward id onto res_id and forward_id', () => {
    expect(forward('fwd-22').toSegments()).toEqual([
      { type: 'forward', data: { id: 'fwd-22', res_id: 'fwd-22', forward_id: 'fwd-22' } },
    ]);
  });

  it('stores node content as given', () => {
    const inner = text('nested');

    expect(node(20002, 'bot', 'plain').toSegments()).toEqual([
      { type: 'node', data: { user_id: 20002, nickname: 'bot', content: 'plain' } },
    ]);
    expect(node(20002, 'bot', { type: 'text', data: { text: 'seg' } }).toSegments()).toEqual([
      {
        type: 'node',
        data: { user_id: 20002, nickname: 'bot', content: { type: 'text', data: { text: 'seg' } } },
      },
    ]);
    expect(node(20002, 'bot', inner).toSegments()).toEqual([
      { type: 'node', data: { user_id: 20002, nickname: 'bot', content: inner } },
    ]);
  });

  it('passes share, music, location, and contact data through', () => {
    expect(share({ url: 'https://ex.test/page', title: 'Page' }).toSegments()).toEqual([
      { type: 'share', data: { url: 'https://ex.test/page', title: 'Page' } },
    ]);
    expect(
      share({
        url: 'https://ex.test/page',
        title: 'Page',
        content: 'blurb',
        image: 'https://ex.test/cover.png',
      }).toSegments(),
    ).toEqual([
      {
        type: 'share',
        data: {
          url: 'https://ex.test/page',
          title: 'Page',
          content: 'blurb',
          image: 'https://ex.test/cover.png',
        },
      },
    ]);
    expect(music({ type: 'qq', id: '991' }).toSegments()).toEqual([
      { type: 'music', data: { type: 'qq', id: '991' } },
    ]);
    expect(
      location({ lat: 30.1, lon: 120.2, title: 'Hangzhou', content: 'West Lake' }).toSegments(),
    ).toEqual([
      {
        type: 'location',
        data: { lat: 30.1, lon: 120.2, title: 'Hangzhou', content: 'West Lake' },
      },
    ]);
    expect(contact('qq', 20002).toSegments()).toEqual([
      { type: 'contact', data: { type: 'qq', id: 20002 } },
    ]);
    expect(contact('group', '987654').toSegments()).toEqual([
      { type: 'contact', data: { type: 'group', id: '987654' } },
    ]);
  });

  it('builds an arbitrary raw segment', () => {
    expect(raw('dice', { result: 3 }).toSegments()).toEqual([
      { type: 'dice', data: { result: 3 } },
    ]);
  });

  it('chains fluent builders in order', () => {
    const built = chain().text('ping').at(20002).br().image('file://b.jpg').face(39);

    expect(built.length).toBe(5);
    expect(built.toSegments()).toEqual([
      { type: 'text', data: { text: 'ping' } },
      { type: 'at', data: { qq: '20002' } },
      { type: 'text', data: { text: '\n' } },
      { type: 'image', data: { file: 'file://b.jpg' } },
      { type: 'face', data: { id: '39' } },
    ]);
  });
});

describe('append', () => {
  it('appends a string as a text segment', () => {
    expect(text('pre').append('post').toSegments()).toEqual([
      { type: 'text', data: { text: 'pre' } },
      { type: 'text', data: { text: 'post' } },
    ]);
    expect(text('pre').append('').toSegments()).toEqual([
      { type: 'text', data: { text: 'pre' } },
      { type: 'text', data: { text: '' } },
    ]);
  });

  it('returns the same instance when appending an empty array', () => {
    const base = text('keep');
    expect(base.append([])).toBe(base);
  });

  it('appends a single segment', () => {
    expect(text('pre').append({ type: 'face', data: { id: '39' } }).toSegments()).toEqual([
      { type: 'text', data: { text: 'pre' } },
      { type: 'face', data: { id: '39' } },
    ]);
  });

  it('appends a segment array', () => {
    expect(
      text('pre')
        .append([
          { type: 'at', data: { qq: 'all' } },
          { type: 'face', data: { id: '39' } },
        ])
        .toSegments(),
    ).toEqual([
      { type: 'text', data: { text: 'pre' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'face', data: { id: '39' } },
    ]);
  });

  it('appends another chain by copying its segments', () => {
    const extra = at(20002).text('!');
    expect(text('pre').append(extra).toSegments()).toEqual([
      { type: 'text', data: { text: 'pre' } },
      { type: 'at', data: { qq: '20002' } },
      { type: 'text', data: { text: '!' } },
    ]);
    expect(extra.toSegments()).toEqual([
      { type: 'at', data: { qq: '20002' } },
      { type: 'text', data: { text: '!' } },
    ]);
  });

  it('appends a duck-typed chain-like value via toSegments', () => {
    const duck = {
      length: 1,
      toSegments() {
        return [{ type: 'poke', data: { type: 6 } }];
      },
      toJSON() {
        return this.toSegments();
      },
    };

    expect(text('pre').append(duck).toSegments()).toEqual([
      { type: 'text', data: { text: 'pre' } },
      { type: 'poke', data: { type: 6 } },
    ]);
  });
});

describe('single-use reply', () => {
  it('throws when reply is added twice through reply()', () => {
    const once = reply(88);
    expect(() => (once as unknown as { reply(id: number): unknown }).reply(89)).toThrow(
      'Message segment "reply" can only appear once in a chain',
    );
  });

  it('throws when a second reply is appended', () => {
    expect(() => reply(88).append({ type: 'reply', data: { id: '89' } })).toThrow(
      'Message segment "reply" can only appear once in a chain',
    );
    expect(() =>
      chain().append([
        { type: 'reply', data: { id: '88' } },
        { type: 'text', data: { text: 'x' } },
        { type: 'reply', data: { id: '89' } },
      ]),
    ).toThrow('Message segment "reply" can only appear once in a chain');
  });

  it('throws when raw reply is added twice', () => {
    expect(() => raw('reply', { id: '88' }).raw('reply', { id: '89' })).toThrow(
      'Message segment "reply" can only appear once in a chain',
    );
  });

  it('allows two independent chains to each have their own reply', () => {
    const base = text('fork');
    expect(base.reply(88).toSegments()).toEqual([
      { type: 'text', data: { text: 'fork' } },
      { type: 'reply', data: { id: '88' } },
    ]);
    expect(base.reply(89).toSegments()).toEqual([
      { type: 'text', data: { text: 'fork' } },
      { type: 'reply', data: { id: '89' } },
    ]);
  });

  it('allows non-reply types, including raw, to appear more than once', () => {
    expect(image('a.webp').image('b.webp').toSegments()).toEqual([
      { type: 'image', data: { file: 'a.webp' } },
      { type: 'image', data: { file: 'b.webp' } },
    ]);
    expect(raw('dice', { result: 1 }).raw('dice', { result: 2 }).toSegments()).toEqual([
      { type: 'dice', data: { result: 1 } },
      { type: 'dice', data: { result: 2 } },
    ]);
  });

  it('still allows other segments after a reply', () => {
    expect(reply(88).text('after').toSegments()).toEqual([
      { type: 'reply', data: { id: '88' } },
      { type: 'text', data: { text: 'after' } },
    ]);
  });
});

describe('serialization and iteration', () => {
  it('returns a shallow copy from build, toArray, toSegments, and toJSON', () => {
    const built = text('copy').at(20002);
    const viaBuild = built.build();
    const viaArray = built.toArray();
    const viaSegments = built.toSegments();
    const viaJson = built.toJSON();
    const expected = [
      { type: 'text', data: { text: 'copy' } },
      { type: 'at', data: { qq: '20002' } },
    ];

    expect(viaBuild).toEqual(expected);
    expect(viaArray).toEqual(expected);
    expect(viaSegments).toEqual(expected);
    expect(viaJson).toEqual(expected);
    expect(viaBuild).not.toBe(viaArray);
    expect(viaArray).not.toBe(viaSegments);
    expect(viaSegments).not.toBe(viaJson);

    viaBuild.push({ type: 'face', data: { id: '1' } });
    expect(built.toSegments()).toEqual(expected);
    expect(built.length).toBe(2);
  });

  it('uses toJSON when stringified', () => {
    expect(JSON.parse(JSON.stringify(text('copy').at(20002)))).toEqual([
      { type: 'text', data: { text: 'copy' } },
      { type: 'at', data: { qq: '20002' } },
    ]);
  });

  it('renders CQ text through toString', () => {
    expect(chain().toString()).toBe('');
    expect(text('A&B[C]').toString()).toBe('A&amp;B&#91;C&#93;');
    expect(text('wave').at(20002).face(39).toString()).toBe('wave[CQ:at,qq=20002][CQ:face,id=39]');
    expect(image('a,b').toString()).toBe('[CQ:image,file=a&#44;b]');
    expect(raw('dice', {}).toString()).toBe('[CQ:dice]');
    expect(chain().append({ type: 'image', data: { file: 'z.webp', url: undefined } }).toString()).toBe(
      '[CQ:image,file=z.webp]',
    );
  });

  it('iterates stored segments', () => {
    const built = text('wave').face(39);
    expect([...built]).toEqual([
      { type: 'text', data: { text: 'wave' } },
      { type: 'face', data: { id: '39' } },
    ]);

    const walked: unknown[] = [];
    for (const segment of built) {
      walked.push(segment);
    }
    expect(walked).toEqual([
      { type: 'text', data: { text: 'wave' } },
      { type: 'face', data: { id: '39' } },
    ]);
  });
});

describe('sendToGroup and sendToPrivate', () => {
  it('forwards the chain instance and options to the client', async () => {
    const client = sender();
    const groupPayload = text('group-hi');
    const privatePayload = text('priv-hi');
    const options = { autoEscape: true, timeoutMs: 2500, echo: 'echo-chain' };

    await expect(groupPayload.sendToGroup(client, 70001, options)).resolves.toEqual({
      message_id: 61001,
    });
    await expect(privatePayload.sendToPrivate(client, 80001, options)).resolves.toEqual({
      message_id: 61002,
    });

    expect(client.sendGroupMessage).toHaveBeenCalledTimes(1);
    expect(client.sendGroupMessage).toHaveBeenCalledWith(70001, groupPayload, options);
    expect(client.sendPrivateMessage).toHaveBeenCalledTimes(1);
    expect(client.sendPrivateMessage).toHaveBeenCalledWith(80001, privatePayload, options);
  });

  it('passes undefined options when none are given', async () => {
    const client = sender();
    const payload = text('plain');

    await payload.sendToGroup(client, 70002);
    await payload.sendToPrivate(client, 80002);

    expect(client.sendGroupMessage).toHaveBeenCalledWith(70002, payload, undefined);
    expect(client.sendPrivateMessage).toHaveBeenCalledWith(80002, payload, undefined);
  });
});

describe('normalizeMessage', () => {
  it('returns a string unchanged', () => {
    expect(normalizeMessage('plain-text')).toBe('plain-text');
    expect(normalizeMessage('')).toBe('');
  });

  it('returns toSegments() for a chain and for duck-typed chain-like values', () => {
    expect(normalizeMessage(text('wave').at(20002))).toEqual([
      { type: 'text', data: { text: 'wave' } },
      { type: 'at', data: { qq: '20002' } },
    ]);

    const segs = [{ type: 'face', data: { id: '39' } }];
    const duck = { toSegments: () => segs };
    expect(normalizeMessage(duck)).toBe(segs);
  });

  it('returns an array input by reference', () => {
    const segs = [{ type: 'text', data: { text: 'arr' } }];
    expect(normalizeMessage(segs)).toBe(segs);
  });

  it('wraps a single segment in a new array', () => {
    const segment = { type: 'text', data: { text: 'solo' } };
    expect(normalizeMessage(segment)).toEqual([segment]);
    expect(normalizeMessage(segment)).not.toBe(segment);
  });

  it('does not treat an object with a non-function toSegments as a chain', () => {
    const value = { type: 'text', data: { text: 'solo' }, toSegments: 0 };
    expect(normalizeMessage(value as never)).toEqual([value]);
  });
});
