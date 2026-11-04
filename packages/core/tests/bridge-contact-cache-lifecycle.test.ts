import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { FetchGroupMemberListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-group-member-list-page';
import { FetchRobotUinRanges } from '@snowluma/protocol/oidb-services/contacts/fetch-robot-uin-ranges';
import { Bridge } from '../src/bridge/bridge';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Bridge contact cache lifecycle', () => {
    it('keeps contact lookups available to packets already draining during shutdown', async () => {
        vi.useFakeTimers();
        const bridge = new Bridge(IdentityService.memory('10001'));
        vi.spyOn(FetchRobotUinRanges, 'invoke').mockResolvedValue({ version: 1, ranges: [] });
        const load = vi
            .spyOn(FetchGroupMemberListPage, 'invoke')
            .mockResolvedValue({ members: [], token: '' });
        await bridge.apis.contacts.fetchGroupMemberList(42);
        let memberRead: Promise<unknown> | undefined;
        bridge.registerCmd('test.contact-cache', () => {
            memberRead = bridge.apis.contacts.fetchGroupMemberList(42);
            return [];
        });
        const packet = bridge.onPacket({
            pid: 1,
            uin: '10001',
            serviceCmd: 'test.contact-cache',
            seqId: 1,
            retCode: 0,
            fromClient: false,
            body: new Uint8Array(),
        });
        const closing = bridge.dispose();
        await packet;
        await expect(memberRead).resolves.toEqual([]);
        await closing;
        expect(load).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])(
        'releases member caches before identity closes, close failure=%s',
        async (fails) => {
            vi.useFakeTimers();
            const identity = IdentityService.memory('10001');
            const bridge = new Bridge(identity);
            vi.spyOn(FetchRobotUinRanges, 'invoke').mockResolvedValue({ version: 1, ranges: [] });
            const load = vi
                .spyOn(FetchGroupMemberListPage, 'invoke')
                .mockResolvedValue({ members: [], token: '' });
            await bridge.apis.contacts.fetchGroupMemberList(42);
            await bridge.apis.contacts.fetchGroupMemberList(42);
            expect(load).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(1);

            const originalClose = identity.close.bind(identity);
            vi.spyOn(identity, 'close').mockImplementation(async () => {
                expect(vi.getTimerCount()).toBe(0);
                await originalClose();

                if (fails) {
                    throw new Error('identity close failed');
                }
            });
            const closing = bridge.dispose();
            expect(bridge.dispose()).toBe(closing);

            if (fails) {
                await expect(closing).rejects.toThrow('identity close failed');
            } else {
                await closing;
            }

            await expect(bridge.apis.contacts.fetchGroupMemberList(42)).rejects.toThrow('disposed');
            expect(load).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
});
