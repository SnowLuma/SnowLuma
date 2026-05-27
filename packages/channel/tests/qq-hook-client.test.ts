import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLiveLinuxPipePids } from '../src/qq-hook-client';

let tmpDir: string | null = null;

async function makeRuntimeDir(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snowluma-hook-'));
  return tmpDir;
}

afterEach(async () => {
  if (!tmpDir) return;
  await rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('listLiveLinuxPipePids', () => {
  it('ignores stale-looking control socket names when the probe rejects them', async () => {
    const runtimeDir = await makeRuntimeDir();
    await writeFile(path.join(runtimeDir, 'mojo.55.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.55.recv.sock'), '');

    const pids = await listLiveLinuxPipePids(runtimeDir, async () => false);

    expect([...pids]).toEqual([]);
  });

  it('returns only connectable control sockets', async () => {
    const runtimeDir = await makeRuntimeDir();
    await writeFile(path.join(runtimeDir, 'mojo.55.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.56.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.56.recv.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.not-a-pid.control.sock'), '');

    const probe = vi.fn(async (socketPath: string) => socketPath.endsWith('mojo.56.control.sock'));
    const pids = await listLiveLinuxPipePids(runtimeDir, probe);

    expect([...pids]).toEqual([56]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
