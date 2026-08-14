import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { findAvailablePort } from '../src/webui/port';

const HOST = '127.0.0.1';
const OTHER_HOST = '127.0.0.2';

const held: net.Server[] = [];

afterEach(async () => {
  await Promise.all(held.splice(0).map(closeServer));
});

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function portOf(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('expected TCP AddressInfo');
  return addr.port;
}

function hold(port: number, host = HOST): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      held.push(server);
      resolve(server);
    });
  });
}

async function release(server: net.Server): Promise<void> {
  const i = held.indexOf(server);
  if (i >= 0) held.splice(i, 1);
  await closeServer(server);
}

/** Bind an ephemeral port that still has a free successor on the same host. */
async function holdWithFreeNext(host = HOST): Promise<number> {
  for (let n = 0; n < 8; n++) {
    const server = await hold(0, host);
    const start = portOf(server);
    if (start >= 65535) {
      await release(server);
      continue;
    }
    try {
      await release(await hold(start + 1, host));
      return start;
    } catch {
      await release(server);
    }
  }
  throw new Error('no occupied port with a free successor');
}

describe('findAvailablePort', () => {
  it('returns start when that TCP port is free', async () => {
    const server = await hold(0);
    const start = portOf(server);
    await release(server);

    expect(await findAvailablePort(start)).toBe(start);
  });

  it('truncates a fractional start toward zero before probing', async () => {
    const server = await hold(0);
    const start = portOf(server);
    await release(server);

    expect(await findAvailablePort(start + 0.9, { maxTries: 1 })).toBe(start);
    expect(await findAvailablePort(start + 0.1, { maxTries: 1 })).toBe(start);
  });

  it('clamps a start above 65535 down to 65535', async () => {
    const probe = await hold(65535);
    expect(portOf(probe)).toBe(65535);
    await release(probe);

    expect(await findAvailablePort(65536, { maxTries: 1 })).toBe(65535);
    expect(await findAvailablePort(70000, { maxTries: 1 })).toBe(65535);
    expect(await findAvailablePort(65535.8, { maxTries: 1 })).toBe(65535);
    expect(await findAvailablePort(Number.POSITIVE_INFINITY, { maxTries: 1 })).toBe(65535);
  });

  it('returns the next port when start is already bound', async () => {
    const start = await holdWithFreeNext();
    expect(await findAvailablePort(start)).toBe(start + 1);
  });

  it('walks forward one port at a time after consecutive collisions', async () => {
    const start = await holdWithFreeNext();
    await hold(start + 1);
    const third = await hold(start + 2);
    await release(third);

    expect(await findAvailablePort(start, { maxTries: 3 })).toBe(start + 2);
  });

  it('throws when maxTries is exhausted on an occupied port', async () => {
    const start = await holdWithFreeNext();
    await expect(findAvailablePort(start, { maxTries: 1 })).rejects.toThrow(
      `No available TCP port found near ${start}`,
    );
  });

  it('throws without probing when maxTries is 0 and keeps the caller start in the message', async () => {
    await expect(findAvailablePort(4123, { maxTries: 0 })).rejects.toThrow(
      'No available TCP port found near 4123',
    );
    await expect(findAvailablePort(0, { maxTries: 0 })).rejects.toThrow(
      'No available TCP port found near 0',
    );
    await expect(findAvailablePort(-20, { maxTries: 0 })).rejects.toThrow(
      'No available TCP port found near -20',
    );
    await expect(findAvailablePort(70000, { maxTries: 0 })).rejects.toThrow(
      'No available TCP port found near 70000',
    );
  });

  it('stops at 65535 instead of wrapping after the last TCP port is taken', async () => {
    await hold(65535);

    await expect(findAvailablePort(65535, { maxTries: 10 })).rejects.toThrow(
      'No available TCP port found near 65535',
    );
    await expect(findAvailablePort(80000, { maxTries: 10 })).rejects.toThrow(
      'No available TCP port found near 80000',
    );
  });

  it('defaults host to 127.0.0.1', async () => {
    const start = await holdWithFreeNext();
    await expect(findAvailablePort(start, { maxTries: 1 })).rejects.toThrow(
      `No available TCP port found near ${start}`,
    );
  });

  it('probes only the requested host', async (ctx) => {
    const start = await holdWithFreeNext();
    try {
      await release(await hold(start, OTHER_HOST));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') {
        ctx.skip(`${OTHER_HOST} is not assigned on this machine`);
      }
      throw error;
    }

    expect(await findAvailablePort(start, { host: OTHER_HOST, maxTries: 1 })).toBe(start);
    await expect(findAvailablePort(start, { host: HOST, maxTries: 1 })).rejects.toThrow(
      `No available TCP port found near ${start}`,
    );
  });

  it('treats a listen failure as unavailable', async () => {
    await expect(
      findAvailablePort(43123, { host: '256.256.256.256', maxTries: 1 }),
    ).rejects.toThrow('No available TCP port found near 43123');
    await expect(findAvailablePort(Number.NaN, { maxTries: 1 })).rejects.toThrow(
      'No available TCP port found near NaN',
    );
  });

  it('returns a port that can actually be bound', async () => {
    const server = await hold(0);
    const start = portOf(server);
    await release(server);

    const found = await findAvailablePort(start, { maxTries: 5 });
    const bound = await hold(found);
    expect(portOf(bound)).toBe(found);
  });
});
