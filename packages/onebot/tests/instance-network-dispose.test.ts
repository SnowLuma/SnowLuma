import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginHistorySyncCoordinator } from '../src/history-sync';
import { OneBotInstance } from '../src/instance';
import type { NetworkShutdownResult } from '../src/network';

afterEach(() => vi.restoreAllMocks());

function fabricatedInstance(results: NetworkShutdownResult[]) {
  const instance = Object.create(OneBotInstance.prototype) as OneBotInstance;
  const closeMessage = vi.fn();
  const closeMedia = vi.fn();
  const closeReaction = vi.fn();
  const shutdown = vi.fn(async () => results.shift() ?? { closed: true, errors: [] });

  Object.assign(instance as unknown as Record<string, unknown>, {
    uin: '10001',
    online: true,
    heartbeatTimer: null,
    eventPipeline: null,
    eventPipelineDrain: Promise.resolve(),
    disposePromise: null,
    disposeRequested: false,
    acceptingActions: true,
    inFlightActions: new Set<Promise<void>>(),
    historySyncAbortController: new AbortController(),
    historySyncTask: null,
    lifecycleTail: Promise.resolve(),
    storeCloseState: { message: false, media: false, reaction: false },
    apiHandler: { quiesce: vi.fn() },
    networkManager: { shutdown },
    messageStore: { close: closeMessage },
    mediaStore: { close: closeMedia },
    reactionStore: { close: closeReaction },
  });

  return { instance, shutdown, closeMessage, closeMedia, closeReaction };
}

describe('OneBotInstance.dispose network/store ordering', () => {
  it('uses the startup opt-in snapshot and starts history sync at most once', async () => {
    const schedule = vi.spyOn(loginHistorySyncCoordinator, 'schedule')
      .mockResolvedValue({
        scannedGroups: 0,
        scannedPrivateUsers: 0,
        selectedGroups: 0,
        selectedPrivateUsers: 0,
        fetchedMessages: 0,
        storedMessages: 0,
        failedSessions: 0,
        truncatedGroups: false,
        truncatedPrivateUsers: false,
      });
    const disabled = fabricatedInstance([{ closed: true, errors: [] }]).instance;
    Object.assign(disabled as unknown as Record<string, unknown>, {
      historySyncEnabledAtStartup: false,
      historySyncStartRequested: false,
      bridge: {},
      converterCtx: {},
      log: { debug: vi.fn(), error: vi.fn() },
    });

    disabled.startLoginHistorySync();
    expect(schedule).not.toHaveBeenCalled();

    const enabled = fabricatedInstance([{ closed: true, errors: [] }]).instance;
    Object.assign(enabled as unknown as Record<string, unknown>, {
      historySyncEnabledAtStartup: true,
      historySyncStartRequested: false,
      bridge: {},
      converterCtx: {},
      log: { debug: vi.fn(), error: vi.fn() },
    });
    enabled.startLoginHistorySync();
    enabled.startLoginHistorySync();
    await Promise.resolve();

    expect(schedule).toHaveBeenCalledOnce();
  });

  it('keeps stores open after an incomplete network shutdown and retries later', async () => {
    const failure = {
      name: 'http',
      kind: 'httpServer' as const,
      phase: 'shutdown' as const,
      message: 'EADDRINUSE release failed',
      at: Date.now(),
    };
    const f = fabricatedInstance([
      { closed: false, errors: [failure] },
      { closed: true, errors: [] },
    ]);

    await expect(f.instance.dispose()).rejects.toThrow(/stores remain open/);
    expect(f.closeMessage).not.toHaveBeenCalled();
    expect(f.closeMedia).not.toHaveBeenCalled();
    expect(f.closeReaction).not.toHaveBeenCalled();

    await expect(f.instance.dispose()).resolves.toEqual({ closed: true, errors: [] });
    expect(f.shutdown).toHaveBeenCalledTimes(2);
    expect(f.closeMessage).toHaveBeenCalledTimes(1);
    expect(f.closeMedia).toHaveBeenCalledTimes(1);
    expect(f.closeReaction).toHaveBeenCalledTimes(1);
  });

  it('retries only stores that did not close successfully', async () => {
    const f = fabricatedInstance([
      { closed: true, errors: [] },
      { closed: true, errors: [] },
    ]);
    f.closeReaction.mockImplementationOnce(() => { throw new Error('reaction close failed'); });

    await expect(f.instance.dispose()).rejects.toThrow(/failed to close OneBot stores/);
    expect(f.closeMessage).toHaveBeenCalledTimes(1);
    expect(f.closeMedia).toHaveBeenCalledTimes(1);
    expect(f.closeReaction).toHaveBeenCalledTimes(1);

    await expect(f.instance.dispose()).resolves.toEqual({ closed: true, errors: [] });
    expect(f.closeMessage).toHaveBeenCalledTimes(1);
    expect(f.closeMedia).toHaveBeenCalledTimes(1);
    expect(f.closeReaction).toHaveBeenCalledTimes(2);
  });

  it('does not close stores while network shutdown is still draining work', async () => {
    const f = fabricatedInstance([]);
    let finishShutdown!: (result: NetworkShutdownResult) => void;
    const draining = new Promise<NetworkShutdownResult>((resolve) => { finishShutdown = resolve; });
    f.shutdown.mockImplementationOnce(() => draining);

    const disposing = f.instance.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.closeMessage).not.toHaveBeenCalled();
    expect(f.closeMedia).not.toHaveBeenCalled();
    expect(f.closeReaction).not.toHaveBeenCalled();

    finishShutdown({ closed: true, errors: [] });
    await disposing;
    expect(f.closeMessage).toHaveBeenCalledTimes(1);
    expect(f.closeMedia).toHaveBeenCalledTimes(1);
    expect(f.closeReaction).toHaveBeenCalledTimes(1);
  });

  it('drains an in-flight instance action before network and stores close', async () => {
    const f = fabricatedInstance([{ closed: true, errors: [] }]);
    let finishAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { finishAction = resolve; });
    const action = (f.instance as unknown as {
      trackAction<T>(label: string, start: () => Promise<T>): Promise<T>;
    }).trackAction('status reply', () => actionGate);

    const disposing = f.instance.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.shutdown).not.toHaveBeenCalled();
    expect(f.closeMessage).not.toHaveBeenCalled();

    finishAction();
    await action;
    await disposing;
    expect(f.shutdown).toHaveBeenCalledTimes(1);
    expect(f.closeMessage).toHaveBeenCalledTimes(1);
  });

  it('stops and drains the event pipeline before network and stores close', async () => {
    const f = fabricatedInstance([{ closed: true, errors: [] }]);
    let finishEvent!: () => void;
    const eventGate = new Promise<void>((resolve) => { finishEvent = resolve; });
    const stop = vi.fn();
    const drain = vi.fn(() => eventGate);
    Object.assign(f.instance as unknown as Record<string, unknown>, {
      eventPipeline: { stop, drain },
    });

    const disposing = f.instance.dispose();
    expect(stop).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.shutdown).not.toHaveBeenCalled();
    expect(f.closeMessage).not.toHaveBeenCalled();

    finishEvent();
    await disposing;
    expect(f.shutdown).toHaveBeenCalledTimes(1);
    expect(f.closeMessage).toHaveBeenCalledTimes(1);
    expect(f.closeMedia).toHaveBeenCalledTimes(1);
    expect(f.closeReaction).toHaveBeenCalledTimes(1);
  });

  it('aborts and drains login history sync before closing message storage', async () => {
    const f = fabricatedInstance([{ closed: true, errors: [] }]);
    let finishSync!: () => void;
    const historySyncTask = new Promise<void>((resolve) => { finishSync = resolve; });
    const controller = new AbortController();
    Object.assign(f.instance as unknown as Record<string, unknown>, {
      historySyncAbortController: controller,
      historySyncTask,
    });

    const disposing = f.instance.dispose();
    expect(controller.signal.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.shutdown).not.toHaveBeenCalled();
    expect(f.closeMessage).not.toHaveBeenCalled();

    finishSync();
    await disposing;
    expect(f.shutdown).toHaveBeenCalledOnce();
    expect(f.closeMessage).toHaveBeenCalledOnce();
  });
});
