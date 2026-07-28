import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ exec: execMock }));

import { probeQqLoginInfo } from '../src/qq-port-probe';

describe('probeQqLoginInfo — bounded execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a later probe after a timed-out attempt', async () => {
    execMock.mockImplementation(() => undefined);
    const first = probeQqLoginInfo(4242);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(first).resolves.toBeNull();

    execMock
      .mockImplementationOnce((_command, _options, callback) => {
        callback(null, { stdout: '', stderr: '' });
      })
      .mockImplementationOnce((_command, _options, callback) => {
        callback(null, { stdout: '1\n', stderr: '' });
      });

    await expect(probeQqLoginInfo(4242)).resolves.toEqual({
      port: 0,
      uin: '',
      loggedIn: false,
    });
  });
});
