import { describe, expect, it, vi } from 'vitest';
import {
    createEventContext,
    isGroupMessageEvent,
    isPrivateMessageEvent,
    matchCommand,
    text,
    type OneBotPrivateMessageEvent,
    type OneBotRequestEvent,
    type SnowLumaApiClient,
} from '../src';

const PRIVATE_EVENT: OneBotPrivateMessageEvent = {
    time: 1,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    message_seq: 8,
    user_id: 10001,
    message: [{ type: 'text', data: { text: '/ping a b' } }],
    raw_message: '/ping a b',
    font: 0,
    sender: { user_id: 10001, nickname: 'tester' },
};

function fakeClient(): SnowLumaApiClient {
    return {
        sendPrivateMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        sendGroupMessage: vi.fn().mockResolvedValue({ message_id: 2 }),
        setFriendAddRequest: vi.fn().mockResolvedValue(null),
        setGroupAddRequest: vi.fn().mockResolvedValue(null),
        raw: vi.fn().mockResolvedValue(null),
    } as unknown as SnowLumaApiClient;
}

describe('event helpers', () => {
    it('narrows message event types', () => {
        expect(isPrivateMessageEvent(PRIVATE_EVENT)).toBe(true);
        expect(isGroupMessageEvent(PRIVATE_EVENT)).toBe(false);
    });

    it('replies to private messages through context', async () => {
        const client = fakeClient();
        const context = createEventContext(PRIVATE_EVENT, client);

        await context.reply(text('pong'));

        expect(client.sendPrivateMessage).toHaveBeenCalledWith(10001, text('pong'), undefined);
    });

    it('approves and rejects request events', async () => {
        const client = fakeClient();
        const request: OneBotRequestEvent = {
            time: 1,
            self_id: 10000,
            post_type: 'request',
            request_type: 'group',
            sub_type: 'invite',
            flag: 'flag-1',
        };
        const context = createEventContext(request, client);

        await context.approve();
        await context.reject('nope');

        expect(client.setGroupAddRequest).toHaveBeenNthCalledWith(1, 'flag-1', {
            subType: 'invite',
            approve: true,
        });
        expect(client.setGroupAddRequest).toHaveBeenNthCalledWith(2, 'flag-1', {
            subType: 'invite',
            approve: false,
            reason: 'nope',
        });
    });

    it('matches commands with prefixes', () => {
        expect(matchCommand(PRIVATE_EVENT, 'ping')).toMatchObject({
            command: 'ping',
            args: ['a', 'b'],
            rest: 'a b',
            prefix: '/',
        });
        expect(matchCommand(PRIVATE_EVENT, 'pong')).toBeNull();
    });
});
