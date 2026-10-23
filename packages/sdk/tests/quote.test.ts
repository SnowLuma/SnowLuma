import { describe, expect, it } from 'vitest';
import { SnowLumaApiClient } from '../src/client/api-client';
import { SnowLumaApiError } from '../src/errors';
import { createEventContext } from '../src/events/context';
import { chain } from '../src/messages/chain';
import { quoteMessage } from '../src/messages/quote';
import { segments } from '../src/messages/segments';
import type {
    ActionParams,
    ActionResult,
    ApiResponse,
    OneBotGroupMessageEvent,
    OneBotPrivateMessageEvent,
    OneBotRequestEvent,
    RequestOptions,
    SnowLumaAction,
} from '../src/types';

class RecordingClient extends SnowLumaApiClient {
    readonly calls: Array<{
        action: string;
        params: unknown;
        options: RequestOptions | undefined;
    }> = [];

    response: ApiResponse = { status: 'ok', retcode: 0, data: { message_id: -19 } };

    async request<TAction extends SnowLumaAction>(
        action: TAction,
        params?: ActionParams<TAction>,
        options?: RequestOptions,
    ): Promise<ApiResponse<ActionResult<TAction>>> {
        this.calls.push({ action, params, options });
        return this.response as ApiResponse<ActionResult<TAction>>;
    }
}

const PRIVATE_EVENT: OneBotPrivateMessageEvent = {
    time: 1,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: -2147483648,
    user_id: 10001,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: 10001, nickname: 'tester' },
};

const GROUP_EVENT: OneBotGroupMessageEvent = {
    ...PRIVATE_EVENT,
    message_type: 'group',
    sub_type: 'normal',
    group_id: 20001,
    message_id: 2147483647,
};

describe('quoteMessage', () => {
    it('preserves CQ strings, extension fields and escaping byte for byte', () => {
        const body = 'hi&amp;[CQ:image,file=a&#44;b,subType=7,extension=keep]';
        expect(quoteMessage(-123, body)).toBe(`[CQ:reply,id=-123]${body}`);
    });

    it('treats the complete string as literal text when autoEscape is enabled', () => {
        const body = '[CQ:reply,id=7] &#91; &amp;';
        expect(quoteMessage(-123, body, { autoEscape: true })).toEqual([
            segments.reply(-123),
            segments.text(body),
        ]);
    });

    it('does not interpret escaped CQ-like text as an existing reply', () => {
        const body = '&#91;CQ:reply,id=7&#93;';
        expect(quoteMessage(-123, body)).toBe(`[CQ:reply,id=-123]${body}`);
    });

    it('adds a quote to one segment, an array and a chain without mutating inputs', () => {
        const segment = Object.freeze({
            type: 'text' as const,
            data: Object.freeze({ text: 'hello' }),
        });
        const array = [segment];
        Object.freeze(array);
        const messageChain = chain().text('hello');
        const expected = [segments.reply(-123), segment];

        expect(quoteMessage(-123, segment)).toEqual(expected);
        expect(quoteMessage(-123, array)).toEqual(expected);
        expect(quoteMessage(-123, messageChain)).toEqual(expected);
        expect(array).toEqual([segment]);
        expect(messageChain.toSegments()).toEqual([segment]);
    });

    it.each([
        '[CQ:reply,id=-12]hello',
        segments.reply(-12),
        [segments.text('hello'), segments.reply(-12)],
        chain().text('hello').reply(-12),
        segments.customReply('quoted'),
    ])('rejects a body that already contains a reply: %j', (body) => {
        expect(() => quoteMessage(-123, body)).toThrow(/containing a reply/);
    });

    it('does not treat replies inside a forward node as an outer reply', () => {
        const node = segments.node(10001, 'tester', [segments.reply(-12), segments.text('body')]);
        expect(quoteMessage(-123, node)).toEqual([segments.reply(-123), node]);
    });

    it.each([0, NaN, Infinity, -Infinity, 1.5, -2147483649, 2147483648])(
        'rejects invalid message ID %s',
        (messageId) => {
            expect(() => quoteMessage(messageId, 'hello')).toThrow(/signed 32-bit message ID/);
        },
    );
});

describe('event context quote', () => {
    it('quotes a private event with its signed ID and forwards request options', async () => {
        const client = new RecordingClient();
        const context = createEventContext(PRIVATE_EVENT, client);
        const options = { signal: new AbortController().signal, timeoutMs: 250, echo: 'quote' };

        await expect(context.quote('reply body', options)).resolves.toEqual({ message_id: -19 });
        expect(client.calls).toEqual([
            {
                action: 'send_private_msg',
                params: {
                    user_id: 10001,
                    message: '[CQ:reply,id=-2147483648]reply body',
                    auto_escape: undefined,
                },
                options,
            },
        ]);
    });

    it('quotes a group event in its group rather than sending privately to its author', async () => {
        const client = new RecordingClient();
        const context = createEventContext(GROUP_EVENT, client);

        await context.quote(chain().text('reply body'));
        expect(client.calls).toEqual([
            {
                action: 'send_group_msg',
                params: {
                    group_id: 20001,
                    message: [segments.reply(2147483647), segments.text('reply body')],
                    auto_escape: undefined,
                },
                options: undefined,
            },
        ]);
    });

    it('sends literal CQ text with autoEscape without escaping the added quote', async () => {
        const client = new RecordingClient();
        const context = createEventContext(PRIVATE_EVENT, client);

        await context.quote('[CQ:reply,id=-99]hello', { autoEscape: true });
        expect(client.calls[0]?.params).toEqual({
            user_id: 10001,
            message: [segments.reply(-2147483648), segments.text('[CQ:reply,id=-99]hello')],
            auto_escape: true,
        });
    });

    it('keeps reply() unquoted and preserves its existing CQ behavior', async () => {
        const client = new RecordingClient();
        const context = createEventContext(PRIVATE_EVENT, client);
        const body = '[CQ:reply,id=7]hello';

        await context.reply(body);
        expect(client.calls[0]?.params).toEqual({
            user_id: 10001,
            message: body,
            auto_escape: undefined,
        });
    });

    it('does not perform a request when the event is not a message', async () => {
        const client = new RecordingClient();
        const event: OneBotRequestEvent = {
            time: 1,
            self_id: 10000,
            post_type: 'request',
            request_type: 'friend',
            user_id: 10001,
            flag: 'request-1',
        };

        await expect(createEventContext(event, client).quote('hello')).rejects.toThrow(
            'quote() is only available for message events',
        );
        expect(client.calls).toHaveLength(0);
    });

    it('does not send duplicate quotes or invalid event IDs', async () => {
        const client = new RecordingClient();

        await expect(
            createEventContext(PRIVATE_EVENT, client).quote('[CQ:reply,id=7]'),
        ).rejects.toThrow(/containing a reply/);
        await expect(
            createEventContext({ ...PRIVATE_EVENT, message_id: 0 }, client).quote('hello'),
        ).rejects.toThrow(/signed 32-bit message ID/);
        expect(client.calls).toHaveLength(0);
    });

    it('preserves the original transport failure', async () => {
        const client = new RecordingClient();
        const failure = new Error('connection lost');

        client.request = async () => {
            throw failure;
        };

        await expect(createEventContext(PRIVATE_EVENT, client).quote('hello')).rejects.toBe(
            failure,
        );
    });

    it('preserves API failure details without retrying the send', async () => {
        const client = new RecordingClient();
        client.response = {
            status: 'failed',
            retcode: 1200,
            data: null,
            wording: 'quote unavailable',
        };

        await expect(
            createEventContext(PRIVATE_EVENT, client).quote('hello'),
        ).rejects.toMatchObject({
            constructor: SnowLumaApiError,
            retcode: 1200,
            wording: 'quote unavailable',
        });
        expect(client.calls).toHaveLength(1);
    });
});
