import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/emitter';

type TestEvents = {
  open: undefined;
  data: string;
  count: number;
  close: { code: number; reason: string };
};

describe('Emitter', () => {
  it('delivers a payload to a listener registered with on', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    emitter.on('data', (payload) => {
      seen.push(payload);
    });
    emitter.emit('data', 'hello');

    expect(seen).toEqual(['hello']);
  });

  it('invokes every listener for the same event in registration order', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    emitter.on('data', (payload) => {
      seen.push(`first:${payload}`);
    });
    emitter.on('data', (payload) => {
      seen.push(`second:${payload}`);
    });
    emitter.emit('data', 'alpha');

    expect(seen).toEqual(['first:alpha', 'second:alpha']);
  });

  it('keeps listeners for different events isolated', () => {
    const emitter = new Emitter<TestEvents>();
    const data: string[] = [];
    const counts: number[] = [];

    emitter.on('data', (payload) => {
      data.push(payload);
    });
    emitter.on('count', (payload) => {
      counts.push(payload);
    });
    emitter.emit('data', 'alpha');
    emitter.emit('count', 7);
    emitter.emit('data', 'beta');

    expect(data).toEqual(['alpha', 'beta']);
    expect(counts).toEqual([7]);
  });

  it('passes the payload object through by reference', () => {
    const emitter = new Emitter<TestEvents>();
    const payload = { code: 1000, reason: 'done' };
    const seen: Array<{ code: number; reason: string }> = [];

    emitter.on('close', (value) => {
      seen.push(value);
    });
    emitter.emit('close', payload);

    expect(seen).toEqual([{ code: 1000, reason: 'done' }]);
    expect(seen[0]).toBe(payload);
  });

  it('forwards an undefined payload for events typed as undefined', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: Array<undefined> = [];

    emitter.on('open', (payload) => {
      seen.push(payload);
    });
    emitter.emit('open', undefined);

    expect(seen).toEqual([undefined]);
  });

  it('stores a listener only once when the same function is registered twice', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];
    const listener = (payload: string) => {
      seen.push(payload);
    };

    emitter.on('data', listener);
    emitter.on('data', listener);
    emitter.emit('data', 'once-only');

    expect(seen).toEqual(['once-only']);
  });

  it('returns an unsubscribe function from on that stops later delivery', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    const off = emitter.on('data', (payload) => {
      seen.push(payload);
    });
    off();
    emitter.emit('data', 'nope');

    expect(seen).toEqual([]);
  });

  it('does not throw when emit is called with no listeners for that event', () => {
    const emitter = new Emitter<TestEvents>();

    expect(() => emitter.emit('data', 'orphan')).not.toThrow();
  });

  it('does not deliver after every listener has been unsubscribed, even if the event key remains', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    const off = emitter.on('data', (payload) => {
      seen.push(payload);
    });
    off();
    emitter.emit('data', 'ghost');

    expect(seen).toEqual([]);
  });

  it('fires a once listener exactly once', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    emitter.once('data', (payload) => {
      seen.push(payload);
    });
    emitter.emit('data', 'first');
    emitter.emit('data', 'second');

    expect(seen).toEqual(['first']);
  });

  it('lets once and on listeners share an event without once firing again', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    emitter.on('data', (payload) => {
      seen.push(`on:${payload}`);
    });
    emitter.once('data', (payload) => {
      seen.push(`once:${payload}`);
    });
    emitter.emit('data', 'a');
    emitter.emit('data', 'b');

    expect(seen).toEqual(['on:a', 'once:a', 'on:b']);
  });

  it('does not call a once listener that was unsubscribed before emit', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    const off = emitter.once('data', (payload) => {
      seen.push(payload);
    });
    off();
    emitter.emit('data', 'nope');

    expect(seen).toEqual([]);
  });

  it('allows calling the once unsubscribe after it has already fired', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    const off = emitter.once('data', (payload) => {
      seen.push(payload);
    });
    emitter.emit('data', 'first');
    off();
    emitter.emit('data', 'second');

    expect(seen).toEqual(['first']);
  });

  it('does not re-enter a once listener that emits the same event again', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    emitter.once('data', (payload) => {
      seen.push(payload);
      emitter.emit('data', 'again');
    });
    emitter.emit('data', 'first');

    expect(seen).toEqual(['first']);
  });

  it('does not cancel a once subscription when off is given the original listener', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];
    const listener = (payload: string) => {
      seen.push(payload);
    };

    emitter.once('data', listener);
    emitter.off('data', listener);
    emitter.emit('data', 'still');

    expect(seen).toEqual(['still']);
  });

  it('removes only the given listener when off is called', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];
    const keep = (payload: string) => {
      seen.push(`keep:${payload}`);
    };
    const drop = (payload: string) => {
      seen.push(`drop:${payload}`);
    };

    emitter.on('data', keep);
    emitter.on('data', drop);
    emitter.off('data', drop);
    emitter.emit('data', 'x');

    expect(seen).toEqual(['keep:x']);
  });

  it('does not throw when off is called for an event that was never registered', () => {
    const emitter = new Emitter<TestEvents>();

    expect(() => {
      emitter.off('data', () => {});
    }).not.toThrow();
  });

  it('does not throw when off is called with a listener that was never added', () => {
    const emitter = new Emitter<TestEvents>();

    emitter.on('data', (payload) => {
      void payload;
    });

    expect(() => {
      emitter.off('data', () => {});
    }).not.toThrow();
  });

  it('still delivers to a listener removed by an earlier listener during the same emit', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];
    const second = (payload: string) => {
      seen.push(`second:${payload}`);
    };

    emitter.on('data', (payload) => {
      seen.push(`first:${payload}`);
      emitter.off('data', second);
    });
    emitter.on('data', second);
    emitter.emit('data', 'keep');

    expect(seen).toEqual(['first:keep', 'second:keep']);
  });

  it('does not deliver to a listener added during the same emit', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];
    const late = (payload: string) => {
      seen.push(`late:${payload}`);
    };

    emitter.on('data', (payload) => {
      seen.push(`early:${payload}`);
      emitter.on('data', late);
    });
    emitter.emit('data', 'now');
    emitter.emit('data', 'next');

    expect(seen).toEqual(['early:now', 'early:next', 'late:next']);
  });

  it('stops all listeners after clear', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: Array<string | number> = [];

    emitter.on('data', (payload) => {
      seen.push(payload);
    });
    emitter.on('count', (payload) => {
      seen.push(payload);
    });
    emitter.clear();
    emitter.emit('data', 'x');
    emitter.emit('count', 1);

    expect(seen).toEqual([]);
  });

  it('accepts new listeners after clear', () => {
    const emitter = new Emitter<TestEvents>();
    const seen: string[] = [];

    emitter.on('data', (payload) => {
      seen.push(`old:${payload}`);
    });
    emitter.clear();
    emitter.on('data', (payload) => {
      seen.push(`new:${payload}`);
    });
    emitter.emit('data', 'after');

    expect(seen).toEqual(['new:after']);
  });

  it('does not throw when off is called after clear', () => {
    const emitter = new Emitter<TestEvents>();
    const listener = (payload: string) => {
      void payload;
    };

    emitter.on('data', listener);
    emitter.clear();

    expect(() => {
      emitter.off('data', listener);
    }).not.toThrow();
  });
});
