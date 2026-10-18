import { setImmediate as nextTurn } from 'node:timers/promises';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeManager } from '../src/bridge/manager';

function deferred() {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe('BridgeManager shutdown', () => {
    let manager: BridgeManager;
    const sender = { sendPacket: vi.fn() } as never;

    beforeEach(() => {
        vi.spyOn(IdentityService, 'openForUin').mockImplementation((uin, _root, beforeOpen) => {
            void beforeOpen?.catch(() => undefined);
            return IdentityService.memory(uin);
        });
        manager = new BridgeManager();
    });

    afterEach(async () => {
        await manager.dispose().catch(() => undefined);
        vi.restoreAllMocks();
    });

    it('drains every detached session for one account and reports each failure once', async () => {
        const previous = deferred();
        const latest = deferred();
        const firstError = new Error('previous close failed');
        const lastError = new Error('latest close failed');
        manager.onHookLogin(101, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(previous.promise);
        manager.onPidDisconnected(101);
        previous.reject(firstError);
        await nextTurn();
        manager.onHookLogin(202, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(latest.promise);
        manager.onPidDisconnected(202);
        let settled = false;
        const result = manager
            .dispose()
            .catch((error: AggregateError) => error)
            .then((error) => {
                settled = true;
                return error;
            });

        try {
            await nextTurn();
            expect(settled).toBe(false);
        } finally {
            latest.reject(lastError);
        }

        const error = await result;
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([firstError, lastError]);
    });

    it('includes the session whose close observer requested shutdown', async () => {
        const cleanup = deferred();
        let shutdown!: Promise<void>;
        let settled = false;
        manager.onHookLogin(101, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(cleanup.promise);
        manager.subscribeSessions({
            closed: () => {
                shutdown = manager.dispose().then(() => {
                    settled = true;
                });
            },
        });
        manager.onPidDisconnected(101);

        try {
            await nextTurn();
            expect(settled).toBe(false);
        } finally {
            cleanup.resolve();
            await shutdown;
        }
    });

    it('waits for every previous close before opening the account again', async () => {
        const first = deferred();
        const second = deferred();
        manager.onHookLogin(101, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(first.promise);
        manager.onPidDisconnected(101);
        manager.onHookLogin(202, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(second.promise);
        manager.onPidDisconnected(202);
        manager.onHookLogin(303, '10001', sender);
        const beforeOpen = vi.mocked(IdentityService.openForUin).mock.calls.at(-1)![2]!;
        let ready = false;
        const opening = beforeOpen.then(() => {
            ready = true;
        });

        try {
            second.resolve();
            await nextTurn();
            expect(ready).toBe(false);
        } finally {
            first.resolve();
            await opening;
        }
    });

    it('reopening is not poisoned by an already-failed close', async () => {
        const failing = deferred();
        manager.onHookLogin(101, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(failing.promise);
        manager.onPidDisconnected(101);
        failing.reject(new Error('close failed'));
        await nextTurn();

        // The failed close stays in the bookkeeping (dispose still reports
        // it), but the reopening gate must absorb the rejection instead of
        // passing it down — a rejected gate would keep the identity DB of
        // every future session for this UIN closed until process restart.
        manager.onHookLogin(202, '10001', sender);
        const beforeOpen = vi.mocked(IdentityService.openForUin).mock.calls.at(-1)![2]!;
        await expect(beforeOpen).resolves.toBeUndefined();
    });

    it('reopening waits for all closes to settle even when one of them fails', async () => {
        const failing = deferred();
        const slow = deferred();
        manager.onHookLogin(101, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(failing.promise);
        manager.onPidDisconnected(101);
        manager.onHookLogin(202, '10001', sender);
        vi.spyOn(manager.getBridge('10001')!.identity, 'close').mockReturnValue(slow.promise);
        manager.onPidDisconnected(202);

        failing.reject(new Error('close failed'));
        await nextTurn();

        manager.onHookLogin(303, '10001', sender);
        const beforeOpen = vi.mocked(IdentityService.openForUin).mock.calls.at(-1)![2]!;
        let ready = false;
        const opening = beforeOpen.then(() => {
            ready = true;
        });

        try {
            await nextTurn();
            // Still waiting for the pending close...
            expect(ready).toBe(false);
        } finally {
            slow.resolve();
        }

        // ...and the already-failed close must not reject the gate.
        await opening;
    });

    it('ignores late transport callbacks after shutdown starts', async () => {
        const shutdown = manager.dispose();
        manager.onHookLogin(101, '10001', sender);
        manager.onPacket({
            pid: 202,
            uin: '20002',
            serviceCmd: 'Test.Unhandled',
            seqId: 1,
            retCode: 0,
            fromClient: false,
            body: Buffer.alloc(0),
        } satisfies PacketInfo);
        manager.onPidReceiveHealthChanged(101, false);
        await shutdown;
        expect(IdentityService.openForUin).not.toHaveBeenCalled();
        expect(manager.getBridge('10001')).toBeNull();
        expect(manager.getBridge('20002')).toBeNull();
    });
});
