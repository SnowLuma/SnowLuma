import { readFile } from 'node:fs/promises';
import type { ReadResourceResult, Resource, Tool } from '@modelcontextprotocol/server';
import { asError, asText, RESULT_SCHEMA, type StructuredResult } from './results.js';

export const MESSAGE_PREVIEW_TOOL = 'preview_message';
export const MESSAGE_APP_URI = 'ui://snowluma/message-preview.html';
export const MESSAGE_APP_MIME_TYPE = 'text/html;profile=mcp-app';

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function supportsMessageApp(capabilities: unknown): boolean {
    if (!record(capabilities) || !record(capabilities.extensions)) {
        return false;
    }

    const ui = capabilities.extensions['io.modelcontextprotocol/ui'];
    return (
        record(ui) && Array.isArray(ui.mimeTypes) && ui.mimeTypes.includes(MESSAGE_APP_MIME_TYPE)
    );
}

export function messagePreviewTool(uiSupported: boolean): Tool {
    return {
        name: MESSAGE_PREVIEW_TOOL,
        description:
            '预览一条纯文本群聊或私聊草稿，可附带引用消息编号。只生成草稿，不发送消息；支持面板的客户端可由用户点击发送，仍受写模式限制。文字按字面发送，不解释消息控制代码。',
        inputSchema: {
            type: 'object',
            properties: {
                message_type: { type: 'string', enum: ['group', 'private'] },
                target_id: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                text: { type: 'string', minLength: 1 },
                reply_to: {
                    type: 'integer',
                    minimum: -2147483648,
                    maximum: 2147483647,
                    not: { const: 0 },
                    description: '可选引用消息编号，负值合法。',
                },
            },
            required: ['message_type', 'target_id', 'text'],
            additionalProperties: false,
        },
        outputSchema: RESULT_SCHEMA,
        annotations: { readOnlyHint: true, openWorldHint: false },
        ...(uiSupported
            ? { _meta: { ui: { resourceUri: MESSAGE_APP_URI, visibility: ['model', 'app'] } } }
            : {}),
    };
}

/** Pure draft construction. Sending remains an ordinary invoke_action call. */
export function previewMessage(args: Record<string, unknown>, canSend: boolean): StructuredResult {
    if (
        Object.keys(args).some(
            (key) => !['message_type', 'target_id', 'text', 'reply_to'].includes(key),
        )
    ) {
        return asError('草稿包含不支持的字段。');
    }

    const { message_type: messageType, target_id: targetId, text, reply_to: replyTo } = args;

    if (messageType !== 'group' && messageType !== 'private') {
        return asError('message_type 必须为 group 或 private。');
    }

    if (typeof targetId !== 'number' || !Number.isSafeInteger(targetId) || targetId <= 0) {
        return asError('target_id 必须是正的安全整数。');
    }

    if (typeof text !== 'string' || text.trim().length === 0) {
        return asError('text 必须是非空文本。');
    }

    if (
        replyTo !== undefined &&
        (typeof replyTo !== 'number' ||
            !Number.isInteger(replyTo) ||
            replyTo === 0 ||
            replyTo < -2147483648 ||
            replyTo > 2147483647)
    ) {
        return asError('reply_to 必须是非零的有符号 32 位消息编号，负值合法。');
    }

    const message: Array<{ type: string; data: Record<string, string> }> = [];

    if (replyTo !== undefined) {
        message.push({ type: 'reply', data: { id: String(replyTo) } });
    }

    // Explicit text segments preserve literal control-code-looking text.
    message.push({ type: 'text', data: { text } });
    return asText({
        draft: {
            message_type: messageType,
            target_id: targetId,
            text,
            ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
        },
        can_send: canSend,
        notice: '此为待发送草稿，尚未发送。',
        invocation: {
            name: 'invoke_action',
            arguments: {
                action: messageType === 'group' ? 'send_group_msg' : 'send_private_msg',
                params: { [messageType === 'group' ? 'group_id' : 'user_id']: targetId, message },
            },
        },
    });
}

export function messageAppResources(uiSupported: boolean): Resource[] {
    return uiSupported
        ? [
              {
                  uri: MESSAGE_APP_URI,
                  name: '消息草稿预览',
                  description: '查看消息草稿并按需手动发送。',
                  mimeType: MESSAGE_APP_MIME_TYPE,
              },
          ]
        : [];
}

export async function readMessageAppResource(uri: string): Promise<ReadResourceResult | undefined> {
    if (uri !== MESSAGE_APP_URI) {
        return undefined;
    }

    // The build emits the same self-contained asset beside this compiled module.
    // A missing asset is a packaging error and must not become a blank panel.
    const text = await readFile(new URL('./message-app.html', import.meta.url), 'utf8');
    return {
        contents: [
            {
                uri,
                mimeType: MESSAGE_APP_MIME_TYPE,
                text,
                _meta: {
                    ui: {
                        csp: {
                            connectDomains: [],
                            resourceDomains: [],
                            frameDomains: [],
                            baseUriDomains: [],
                        },
                        prefersBorder: true,
                    },
                },
            },
        ],
    };
}
