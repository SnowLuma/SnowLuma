import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execMock = vi.hoisted(() => vi.fn());
const socketCtorMock = vi.hoisted(() => vi.fn(function MockSocket() {
  throw new Error('interactive QQ probe must not run');
}));

vi.mock('child_process', () => ({ exec: execMock }));
vi.mock('net', () => ({
  default: { Socket: socketCtorMock },
  Socket: socketCtorMock,
}));

import { probeQqLoginInfo } from '../src/qq-port-probe';

describe('probeQqLoginInfo — bounded execution', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    execMock.mockReset();
    socketCtorMock.mockClear();
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
      identityKnown: false,
    });
  });

  it('keeps background identity discovery passive', async () => {
    execMock
      .mockImplementationOnce((_command, _options, callback) => {
        callback(null, {
          stdout: 'LISTEN 0 128 127.0.0.1:9218 0.0.0.0:* users:(("qq",pid=4242,fd=12))\n',
          stderr: '',
        });
      })
      .mockImplementationOnce((command: string, _options, callback) => {
        if (String(command).includes('tasklist')) {
          // Windows: tasklist output is filtered by "qq.exe" lines
          callback(null, { stdout: 'qq.exe\n'.repeat(8), stderr: '' });
        } else {
          callback(null, { stdout: '8\n', stderr: '' });
        }
      });

    await expect(probeQqLoginInfo(4242)).resolves.toBeNull();
    expect(socketCtorMock).not.toHaveBeenCalled();
  });
});
