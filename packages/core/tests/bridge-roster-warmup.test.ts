import { describe, expect, it, vi } from 'vitest';
import type { PacketSender } from '@snowluma/common/packet-sender';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type {
    FriendInfo,
    GroupMemberInfo,
    QQGroupInfo,
    UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import { Bridge } from '../src/bridge/bridge';

const sender: PacketSender = {
    sendPacket: async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.alloc(0),
    }),
};

function makeFriend(uin: number, uid: string, nickname: string): FriendInfo {
    return { uin, uid, nickname, remark: '' };
}

function makeGroup(groupId: number): QQGroupInfo {
    return {
        groupId,
        groupName: 'group',
        remark: '',
        memberCount: 1,
        memberMax: 200,
        members: new Map(),
    };
}

function makeMember(uin: number, uid: string): GroupMemberInfo {
    return {
        uin,
        uid,
        nickname: `nick-${uin}`,
        card: '',
        role: 'member',
        level: 0,
        title: '',
        joinTime: 0,
        lastSentTime: 0,
        shutUpTime: 0,
    };
}

function makeProfile(uin: number, uid: string, nickname: string): UserProfileInfo {
    return {
        uin,
        uid,
        nickname,
        remark: '',
        qid: '',
        sex: 'unknown',
        age: 0,
        sign: '',
        avatar: '',
        level: 0,
        qidianMasterFlag: 0,
        qidianCrewFlag: 0,
        qidianCrewFlag2: 0,
    };
}

describe('Bridge roster warmup', () => {
    it('settles all callers, including callers waiting before the first connection', async () => {
        const bridge = new Bridge(IdentityService.memory('10001'));
        const fetchFriends = vi
            .spyOn(bridge.apis.contacts, 'fetchFriendList')
            .mockResolvedValue([makeFriend(10001, 'u_self', 'me')]);
        vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockResolvedValue([]);
        const beforeLogin = bridge.whenRosterWarmupSettled();

        bridge.bindPid(7, sender);
        const afterLogin = bridge.whenRosterWarmupSettled();
        const expected = { friendsLoaded: true, groupsLoaded: true };
        await expect(Promise.all([beforeLogin, afterLogin])).resolves.toEqual([expected, expected]);
        await expect(bridge.whenRosterWarmupSettled()).resolves.toEqual(expected);
        expect(fetchFriends).toHaveBeenCalledOnce();
        await bridge.dispose();
        await expect(bridge.whenRosterWarmupSettled()).resolves.toEqual(expected);
    });

    it('releases warmup waiters when disposed before the first connection', async () => {
        const bridge = new Bridge(IdentityService.memory('10001'));
        const waiting = bridge.whenRosterWarmupSettled();
        await bridge.dispose();
        await expect(waiting).resolves.toEqual({ friendsLoaded: false, groupsLoaded: false });
        await expect(bridge.whenRosterWarmupSettled()).resolves.toEqual({
            friendsLoaded: false,
            groupsLoaded: false,
        });
    });

    it('fetches friends and groups after the first sender and writes Identity', async () => {
        const identity = IdentityService.memory('10001');
        const bridge = new Bridge(identity);
        const friends = [
            makeFriend(10001, 'u_self', 'me'),
            makeFriend(22222, 'u_friend', 'friend'),
        ];
        const groups = [makeGroup(123)];
        const members = [makeMember(33333, 'u_member')];
        const fetchFriendList = vi
            .spyOn(bridge.apis.contacts, 'fetchFriendList')
            .mockImplementation(async () => {
                identity.rememberFriends(friends);
                return friends;
            });
        vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockImplementation(async () => {
            identity.rememberGroups(groups);
            return groups;
        });
        vi.spyOn(bridge.apis.contacts, 'fetchGroupMemberList').mockImplementation(
            async (groupId) => {
                identity.rememberGroupMembers(groupId, members);
                return members;
            },
        );

        bridge.bindPid(7, sender);
        const result = await bridge.whenRosterWarmupSettled();

        expect(result).toEqual({ friendsLoaded: true, groupsLoaded: true });
        expect(fetchFriendList).toHaveBeenCalledOnce();
        expect(identity.nickname).toBe('me');
        expect(identity.findFriend(22222)?.uid).toBe('u_friend');
        expect(identity.findGroup(123)?.groupName).toBe('group');
        expect(identity.findGroupMember(123, 33333)?.uid).toBe('u_member');
        await bridge.dispose();
    });

    it('does not retry a failed friend list fetch', async () => {
        const identity = IdentityService.memory('10001');
        const bridge = new Bridge(identity);
        const fetchFriendList = vi
            .spyOn(bridge.apis.contacts, 'fetchFriendList')
            .mockRejectedValue(new Error('net'));
        vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockResolvedValue([]);
        vi.spyOn(bridge.apis.contacts, 'fetchUserProfile').mockResolvedValue(
            makeProfile(10001, 'u_self', 'me'),
        );

        bridge.bindPid(7, sender);
        const result = await bridge.whenRosterWarmupSettled();

        expect(result).toEqual({ friendsLoaded: false, groupsLoaded: true });
        expect(fetchFriendList).toHaveBeenCalledOnce();
        bridge.bindPid(8, sender);
        await bridge.whenRosterWarmupSettled();
        expect(fetchFriendList).toHaveBeenCalledOnce();
        await bridge.dispose();
    });

    it('discards in-flight warmup writes after dispose', async () => {
        const identity = IdentityService.memory('10001');
        const bridge = new Bridge(identity);
        let releaseFriends!: (friends: FriendInfo[]) => void;
        const friendsGate = new Promise<FriendInfo[]>((resolve) => {
            releaseFriends = resolve;
        });
        vi.spyOn(bridge.apis.contacts, 'fetchFriendList').mockReturnValue(friendsGate);
        vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockResolvedValue([]);

        bridge.bindPid(7, sender);
        const settled = bridge.whenRosterWarmupSettled();
        await bridge.dispose();
        releaseFriends([makeFriend(22222, 'u_friend', 'friend')]);

        await expect(settled).resolves.toEqual({ friendsLoaded: false, groupsLoaded: false });
        expect(() => {
            identity.nickname = 'x';
        }).toThrow(/closed/);
    });
});
