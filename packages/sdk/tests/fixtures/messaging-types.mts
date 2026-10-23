import {
    createEventContext,
    isGroupMessageEvent,
    quoteMessage,
    text,
    type EventHandler,
    type EventMiddleware,
    type EventWaitOptions,
    type MediaSource,
    type OneBotGroupMessageEvent,
    type OneBotMessageEvent,
    type SendMessageResult,
    type SnowLumaEvent,
    type SnowLumaEventContext,
    type SnowLumaEventContextWithQuote,
    type SnowLumaHttpClient,
    type SnowLumaWebSocketClient,
} from '@snowluma/sdk';
import { localFile } from '@snowluma/sdk/node';
import type { EventWaitOptions as ClientWaitOptions } from '@snowluma/sdk/client';
import type { SendImageOptions } from '@snowluma/sdk/types';
import { quoteMessage as messageQuote } from '@snowluma/sdk/messages';

declare const http: SnowLumaHttpClient;
declare const ws: SnowLumaWebSocketClient;
declare const event: OneBotMessageEvent;
const source: MediaSource = await localFile('./picture.png');
const options: SendImageOptions = { image: { summary: 'picture' }, chunkSize: 16384 };
const sent: Promise<SendMessageResult> = http.sendGroupImage(123, source, options);
const sentPrivate: Promise<SendMessageResult> = ws.sendPrivateVideo(456, new Blob(['bytes']));
const file: Promise<{ file_id: string | null }> = ws.sendPrivateFile(456, new Uint8Array([1]));
ws.sendGroupFile(
    123,
    { source: new Blob(['bytes']), filename: 'notes.txt' },
    { folderId: '/docs' },
);
// @ts-expect-error Strings remain server paths; opening a local file must be explicit.
http.sendPrivateImage(456, './picture.png');
// @ts-expect-error Media attributes remain checked.
http.sendGroupImage(123, source, { image: { subType: 'invalid' } });

const oldContext: SnowLumaEventContext<OneBotMessageEvent> = {
    event,
    client: http,
    stopped: false,
    stopPropagation() {},
    async reply() {},
    async approve() {},
    async reject() {},
    async quickOperation() {},
};

const oldHandler: EventHandler<OneBotMessageEvent> = async (_event, context) => {
    await context.reply('unchanged');
};

oldHandler(event, oldContext);
ws.onMessage(oldHandler);

const oldMiddleware: EventMiddleware = async (_event, context, next) => {
    await context.reply('unchanged');
    await next();
};

oldMiddleware(event, oldContext, async () => {});
ws.use(oldMiddleware);

const context: SnowLumaEventContextWithQuote<OneBotMessageEvent> = createEventContext(event, http);
const quoted: Promise<SendMessageResult> = context.quote(text('hello'));
ws.onMessage(async (_event, ctx) => {
    await ctx.quote('hello');
});
ws.onGroupMessage(async (_event, ctx) => {
    await ctx.quote('hello');
});
ws.use(async (_event, ctx, next) => {
    await ctx.quote('hello');
    await next();
});
ws.command('ping', async (_event, ctx) => {
    await ctx.quote('pong');
});
http.sendGroupMessage(123, quoteMessage(-42, 'body'));
http.sendPrivateMessage(456, messageQuote(-42, text('body')));

const waitOptions: EventWaitOptions & ClientWaitOptions = {
    timeoutMs: 100,
    signal: new AbortController().signal,
};
const group: Promise<OneBotGroupMessageEvent> = ws.waitForEvent(isGroupMessageEvent, waitOptions);
const groupMessage: Promise<OneBotGroupMessageEvent> = ws.waitForMessage(isGroupMessageEvent);
const message: Promise<OneBotMessageEvent> = ws.waitForMessage(
    (e) => e.user_id === 456,
    waitOptions,
);
const anyEvent: Promise<SnowLumaEvent> = ws.waitForEvent(waitOptions);
ws.waitForEvent(undefined, waitOptions);
ws.waitForMessage(waitOptions);
// @ts-expect-error A filter without a type guard does not promise group fields.
const wrong: Promise<OneBotGroupMessageEvent> = ws.waitForEvent(() => true);
// @ts-expect-error Wait predicates are synchronous.
ws.waitForMessage(async () => true);
export { sent, sentPrivate, file, quoted, group, groupMessage, message, anyEvent, wrong };
