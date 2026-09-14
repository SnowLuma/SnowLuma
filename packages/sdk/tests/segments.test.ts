import { describe, expect, it } from 'vitest';
import { segments } from '../src/messages/segments';

describe('segments.text', () => {
  it('wraps a string as a text segment', () => {
    expect(segments.text('hello')).toEqual({ type: 'text', data: { text: 'hello' } });
  });

  it('keeps empty text', () => {
    expect(segments.text('')).toEqual({ type: 'text', data: { text: '' } });
  });
});

describe('segments.face', () => {
  it('stringifies a numeric face id', () => {
    expect(segments.face(14)).toEqual({ type: 'face', data: { id: '14' } });
  });

  it('keeps a string face id', () => {
    expect(segments.face('178')).toEqual({ type: 'face', data: { id: '178' } });
  });

  it('stringifies zero', () => {
    expect(segments.face(0)).toEqual({ type: 'face', data: { id: '0' } });
  });
});

describe('segments.at', () => {
  it('stringifies a numeric qq and omits empty options', () => {
    expect(segments.at(10001)).toEqual({ type: 'at', data: { qq: '10001' } });
  });

  it('supports at-all', () => {
    expect(segments.at('all')).toEqual({ type: 'at', data: { qq: 'all' } });
  });

  it('includes name when provided', () => {
    expect(segments.at(10001, { name: 'luma' })).toEqual({
      type: 'at',
      data: { qq: '10001', name: 'luma' },
    });
  });

  it('includes uid when provided', () => {
    expect(segments.at(10001, { uid: 'u_abc' })).toEqual({
      type: 'at',
      data: { qq: '10001', uid: 'u_abc' },
    });
  });

  it('includes both name and uid', () => {
    expect(segments.at(10001, { name: 'luma', uid: 'u_abc' })).toEqual({
      type: 'at',
      data: { qq: '10001', name: 'luma', uid: 'u_abc' },
    });
  });

  it('omits empty name and uid', () => {
    expect(segments.at(10001, { name: '', uid: '' })).toEqual({
      type: 'at',
      data: { qq: '10001' },
    });
  });
});

describe('segments.reply', () => {
  it('stringifies a numeric message id', () => {
    expect(segments.reply(7)).toEqual({ type: 'reply', data: { id: '7' } });
  });

  it('keeps a string message id', () => {
    expect(segments.reply('abc')).toEqual({ type: 'reply', data: { id: 'abc' } });
  });
});

describe('segments.image', () => {
  it('uses only the file when no options are given', () => {
    expect(segments.image('/tmp/a.png')).toEqual({
      type: 'image',
      data: { file: '/tmp/a.png' },
    });
  });

  it('spreads image options after file', () => {
    expect(
      segments.image('base64://abc', {
        type: 'flash',
        subType: 1,
        summary: 'pic',
        url: 'https://example.com/a.png',
      }),
    ).toEqual({
      type: 'image',
      data: {
        file: 'base64://abc',
        type: 'flash',
        subType: 1,
        summary: 'pic',
        url: 'https://example.com/a.png',
      },
    });
  });
});

describe('segments.record', () => {
  it('uses only the file when no options are given', () => {
    expect(segments.record('/tmp/a.amr')).toEqual({
      type: 'record',
      data: { file: '/tmp/a.amr' },
    });
  });

  it('spreads record options after file', () => {
    expect(segments.record('/tmp/a.amr', { url: 'https://example.com/a.amr' })).toEqual({
      type: 'record',
      data: { file: '/tmp/a.amr', url: 'https://example.com/a.amr' },
    });
  });
});

describe('segments.video', () => {
  it('uses only the file when no options are given', () => {
    expect(segments.video('/tmp/a.mp4')).toEqual({
      type: 'video',
      data: { file: '/tmp/a.mp4' },
    });
  });

  it('spreads video options after file', () => {
    expect(
      segments.video('/tmp/a.mp4', {
        url: 'https://example.com/a.mp4',
        thumb: '/tmp/thumb.jpg',
      }),
    ).toEqual({
      type: 'video',
      data: {
        file: '/tmp/a.mp4',
        url: 'https://example.com/a.mp4',
        thumb: '/tmp/thumb.jpg',
      },
    });
  });
});

describe('segments.json', () => {
  it('keeps a JSON string as-is', () => {
    expect(segments.json('{"app":"com.tencent.miniapp"}')).toEqual({
      type: 'json',
      data: { data: '{"app":"com.tencent.miniapp"}' },
    });
  });

  it('stringifies a JSON object', () => {
    expect(segments.json({ app: 'com.tencent.miniapp', desc: 'hi' })).toEqual({
      type: 'json',
      data: { data: '{"app":"com.tencent.miniapp","desc":"hi"}' },
    });
  });
});

describe('segments.xml', () => {
  it('uses only the xml payload when no options are given', () => {
    expect(segments.xml('<msg />')).toEqual({
      type: 'xml',
      data: { data: '<msg />' },
    });
  });

  it('spreads xml options after data', () => {
    expect(segments.xml('<msg />', { id: '12345' })).toEqual({
      type: 'xml',
      data: { data: '<msg />', id: '12345' },
    });
  });
});

describe('segments.poke', () => {
  it('omits id when it is not provided', () => {
    expect(segments.poke(1)).toEqual({ type: 'poke', data: { type: 1 } });
  });

  it('includes a numeric id', () => {
    expect(segments.poke(1, -1)).toEqual({ type: 'poke', data: { type: 1, id: -1 } });
  });

  it('keeps string type and id', () => {
    expect(segments.poke('1', '0')).toEqual({ type: 'poke', data: { type: '1', id: '0' } });
  });

  it('includes an id of 0', () => {
    expect(segments.poke(1, 0)).toEqual({ type: 'poke', data: { type: 1, id: 0 } });
  });
});

describe('segments.forward', () => {
  it('mirrors the id onto res_id and forward_id', () => {
    expect(segments.forward('res-9')).toEqual({
      type: 'forward',
      data: { id: 'res-9', res_id: 'res-9', forward_id: 'res-9' },
    });
  });
});

describe('segments.node', () => {
  it('stores user_id, nickname, and string content', () => {
    expect(segments.node(10001, 'luma', 'hello')).toEqual({
      type: 'node',
      data: { user_id: 10001, nickname: 'luma', content: 'hello' },
    });
  });

  it('stores a single segment as content', () => {
    expect(segments.node(10001, 'luma', { type: 'text', data: { text: 'hi' } })).toEqual({
      type: 'node',
      data: {
        user_id: 10001,
        nickname: 'luma',
        content: { type: 'text', data: { text: 'hi' } },
      },
    });
  });

  it('stores a segment array as content', () => {
    expect(segments.node(10001, 'luma', [{ type: 'text', data: { text: 'hi' } }])).toEqual({
      type: 'node',
      data: {
        user_id: 10001,
        nickname: 'luma',
        content: [{ type: 'text', data: { text: 'hi' } }],
      },
    });
  });
});

describe('segments.share', () => {
  it('passes required share fields through', () => {
    expect(segments.share({ url: 'https://example.com', title: 'Example' })).toEqual({
      type: 'share',
      data: { url: 'https://example.com', title: 'Example' },
    });
  });

  it('passes optional share fields through', () => {
    expect(
      segments.share({
        url: 'https://example.com',
        title: 'Example',
        content: 'desc',
        image: 'https://example.com/a.png',
      }),
    ).toEqual({
      type: 'share',
      data: {
        url: 'https://example.com',
        title: 'Example',
        content: 'desc',
        image: 'https://example.com/a.png',
      },
    });
  });
});

describe('segments.music', () => {
  it('passes platform music id data through', () => {
    expect(segments.music({ type: '163', id: '12345' })).toEqual({
      type: 'music',
      data: { type: '163', id: '12345' },
    });
  });

  it('passes custom music data through', () => {
    expect(
      segments.music({
        type: 'custom',
        url: 'https://example.com/song',
        audio: 'https://example.com/song.mp3',
        title: 'Song',
        image: 'https://example.com/cover.jpg',
        content: 'Artist',
      }),
    ).toEqual({
      type: 'music',
      data: {
        type: 'custom',
        url: 'https://example.com/song',
        audio: 'https://example.com/song.mp3',
        title: 'Song',
        image: 'https://example.com/cover.jpg',
        content: 'Artist',
      },
    });
  });
});

describe('segments.location', () => {
  it('passes numeric coordinates and labels through', () => {
    expect(
      segments.location({
        lat: 39.9,
        lon: 116.4,
        title: 'Beijing',
        content: 'Tiananmen',
      }),
    ).toEqual({
      type: 'location',
      data: {
        lat: 39.9,
        lon: 116.4,
        title: 'Beijing',
        content: 'Tiananmen',
      },
    });
  });

  it('passes string coordinates through', () => {
    expect(segments.location({ lat: '31.2', lon: '121.5' })).toEqual({
      type: 'location',
      data: { lat: '31.2', lon: '121.5' },
    });
  });
});

describe('segments.contact', () => {
  it('builds a qq contact with a numeric id', () => {
    expect(segments.contact('qq', 10001)).toEqual({
      type: 'contact',
      data: { type: 'qq', id: 10001 },
    });
  });

  it('builds a group contact with a string id', () => {
    expect(segments.contact('group', '123456')).toEqual({
      type: 'contact',
      data: { type: 'group', id: '123456' },
    });
  });
});

describe('segments.raw', () => {
  it('builds an arbitrary typed segment', () => {
    expect(segments.raw('dice', { result: 6 })).toEqual({
      type: 'dice',
      data: { result: 6 },
    });
  });
});
