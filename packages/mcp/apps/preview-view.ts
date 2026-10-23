import type { App } from '@modelcontextprotocol/ext-apps';

export type PreviewApp = Pick<
    App,
    | 'ontoolresult'
    | 'ontoolcancelled'
    | 'onerror'
    | 'onclose'
    | 'connect'
    | 'getHostCapabilities'
    | 'callServerTool'
>;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Draft {
    message_type: 'group' | 'private';
    target_id: number;
    text: string;
    reply_to?: number;
}

function parseDraft(value: unknown): Draft | undefined {
    if (
        !record(value) ||
        (value.message_type !== 'group' && value.message_type !== 'private') ||
        typeof value.target_id !== 'number' ||
        !Number.isSafeInteger(value.target_id) ||
        value.target_id <= 0 ||
        typeof value.text !== 'string' ||
        value.text.trim().length === 0 ||
        (value.reply_to !== undefined &&
            (typeof value.reply_to !== 'number' ||
                !Number.isInteger(value.reply_to) ||
                value.reply_to === 0 ||
                value.reply_to < -2147483648 ||
                value.reply_to > 2147483647))
    ) {
        return undefined;
    }

    return {
        message_type: value.message_type,
        target_id: value.target_id,
        text: value.text,
        ...(value.reply_to !== undefined ? { reply_to: value.reply_to } : {}),
    };
}

export function mountMessagePreview(app: PreviewApp, document: Document): void {
    const element = (id: string) => {
        const value = document.getElementById(id);

        if (!value) {
            throw new Error(`Missing preview element: ${id}`);
        }

        return value;
    };

    const target = element('target');
    const body = element('message');
    const reply = element('reply');
    const status = element('status');
    const send = element('send') as HTMLButtonElement;
    const cancel = element('cancel') as HTMLButtonElement;
    let draft: Draft | undefined;
    let canSend = false;
    let connected = false;
    let attempted = false;
    let cancelled = false;

    const update = () => {
        send.disabled = !connected || !canSend || !draft || attempted || cancelled;
        cancel.disabled = !draft || attempted || cancelled;
    };

    const stop = (message: string) => {
        connected = false;
        status.textContent = message;
        update();
    };

    app.ontoolresult = (result) => {
        // A host may repeat delivery on restoration; never re-arm a sent draft.
        if (attempted || cancelled) {
            return;
        }

        const data = record(result.structuredContent) ? result.structuredContent.result : undefined;
        draft = !result.isError && record(data) ? parseDraft(data.draft) : undefined;
        canSend = record(data) && data.can_send === true;

        if (!draft) {
            target.textContent = '未收到有效草稿';
            body.textContent = '';
            reply.textContent = '';
            status.textContent = '草稿无效，请重新创建。';
            update();
            return;
        }

        target.textContent = `${draft.message_type === 'group' ? '群聊' : '私聊'} · ${draft.target_id}`;
        body.textContent = draft.text;
        reply.textContent = draft.reply_to === undefined ? '' : `引用消息：${draft.reply_to}`;
        status.textContent = canSend
            ? '消息尚未发送，请核对收件人和正文。'
            : '当前连接仅允许预览。';
        update();
    };

    app.ontoolcancelled = () => {
        cancelled = true;
        status.textContent = '此草稿已取消。';
        update();
    };

    app.onerror = () => stop('连接出现错误。请重新打开预览；发送状态需以会话为准。');
    app.onclose = () => stop('连接已断开。请重新打开预览；发送状态需以会话为准。');
    cancel.addEventListener('click', () => {
        if (attempted) {
            return;
        }

        cancelled = true;
        status.textContent = '此草稿已取消，未发送消息。';
        update();
    });
    send.addEventListener('click', async () => {
        if (!connected || !canSend || !draft || attempted || cancelled) {
            return;
        }

        attempted = true;
        update();
        status.textContent = '正在发送…';
        const message: Array<{ type: string; data: Record<string, string> }> = [];

        if (draft.reply_to !== undefined) {
            message.push({ type: 'reply', data: { id: String(draft.reply_to) } });
        }

        message.push({ type: 'text', data: { text: draft.text } });

        try {
            const result = await app.callServerTool({
                name: 'invoke_action',
                arguments: {
                    action: draft.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
                    params: {
                        [draft.message_type === 'group' ? 'group_id' : 'user_id']: draft.target_id,
                        message,
                    },
                },
            });
            const structured = result.structuredContent;
            const envelope = record(structured) ? structured.result : undefined;
            const diagnostics = record(structured) ? structured.diagnostics : undefined;

            if (
                !result.isError &&
                record(envelope) &&
                envelope.status === 'ok' &&
                envelope.retcode === 0
            ) {
                const data = envelope.data;
                const messageId = record(data) ? data.message_id : undefined;
                status.textContent =
                    typeof messageId === 'number' && Number.isInteger(messageId)
                        ? `服务端已接受消息。消息编号：${messageId}`
                        : '服务端已接受消息。';
            } else if (record(diagnostics) && diagnostics.outcome === 'failed') {
                status.textContent = `发送失败：${typeof diagnostics.message === 'string' ? diagnostics.message : '服务端拒绝了请求。'} 如需重试，请创建新草稿。`;
            } else {
                status.textContent = '发送状态尚未确认。请先检查会话，不要重复发送。';
            }
        } catch {
            status.textContent = '发送状态尚未确认。请先检查会话，不要重复发送。';
        }
    });
    update();
    void app.connect().then(
        () => {
            connected = app.getHostCapabilities()?.serverTools !== undefined;

            if (!connected) {
                status.textContent = '当前客户端仅支持预览，不能从面板发送。';
            }

            update();
        },
        () => stop('无法连接到消息服务。请重新打开预览。'),
    );
}
