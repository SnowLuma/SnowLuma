import type { JsonSchema } from './action-kit';

// Documentation fragments only. They never validate or transform runtime data.
export const messageIdSchema: JsonSchema = {
    type: 'integer',
    minimum: -2147483648,
    maximum: 2147483647,
    not: { const: 0 },
    description: '非零有符号 32 位消息 ID，负值合法；必须原样保留',
};

export const messageResultSchema: JsonSchema = {
    type: 'object',
    properties: { message_id: messageIdSchema },
    required: ['message_id'],
};

export const messageSegmentSchema: JsonSchema = {
    type: 'object',
    properties: {
        type: { type: 'string', description: '消息段类型，例如 text、image、reply' },
        data: {
            type: 'object',
            description: '字段随消息段类型变化，例如 text 段包含 text，reply 段包含 id',
            additionalProperties: true,
        },
    },
    required: ['type', 'data'],
};

/** Stored events retain subtype-specific fields; legacy records can omit fields. */
export const messageDataSchema = {
    type: 'object',
    properties: {
        time: { type: 'integer', description: '消息时间，Unix 秒' },
        message_type: { type: 'string', enum: ['private', 'group'] },
        sub_type: { type: 'string', description: '消息子类型' },
        message_id: messageIdSchema,
        real_id: { type: 'integer', description: '原始 message_id；旧历史记录缺失时可为 0' },
        user_id: { type: 'integer', description: '发送者 QQ 号' },
        group_id: { type: 'integer', description: '群聊消息的群号，私聊可省略' },
        target_id: { type: 'integer', description: '私聊目标 QQ 号（若有）' },
        message: { type: 'array', items: messageSegmentSchema },
        raw_message: { type: 'string', description: '消息的 CQ 码字符串形式' },
        font: { type: 'integer' },
        sender: {
            type: 'object',
            properties: {
                user_id: { type: 'integer' },
                nickname: { type: 'string' },
                card: { type: 'string' },
                sex: { type: 'string', enum: ['male', 'female', 'unknown'] },
                age: { type: 'integer' },
                area: { type: 'string' },
                level: { type: 'string' },
                role: { type: 'string', enum: ['owner', 'admin', 'member'] },
                title: { type: 'string' },
            },
            additionalProperties: true,
        },
    },
    additionalProperties: true,
} satisfies JsonSchema;

// Forward nodes carry their original identifiers, not locally hashed message IDs.
export const forwardNodeSchema: JsonSchema = {
    ...messageDataSchema,
    properties: {
        ...messageDataSchema.properties,
        self_id: { type: 'integer' },
        post_type: { const: 'message' },
        message_format: { const: 'array' },
        message_id: { type: 'integer', description: '转发节点原始标识，缺失时为 0' },
        message_seq: { type: 'integer', description: '节点消息序号，缺失时使用节点标识或 0' },
        real_id: { type: 'integer', description: '与节点 message_id 相同' },
    },
    required: [
        'self_id',
        'user_id',
        'time',
        'message_id',
        'message_seq',
        'real_id',
        'message_type',
        'sender',
        'raw_message',
        'font',
        'sub_type',
        'message',
        'message_format',
        'post_type',
    ],
};

export const mediaInfoSchema: JsonSchema = {
    type: 'object',
    properties: {
        file: { type: 'string', description: '媒体地址；图片无地址时可为原文件标识' },
        url: { type: 'string', description: '媒体下载地址，图片地址可能为空' },
        file_size: { type: 'string', description: '原媒体字节数的十进制字符串' },
        file_name: { type: 'string', description: '文件名或缓存标识' },
    },
    required: ['file', 'url', 'file_size', 'file_name'],
};

export const flashFileSchema: JsonSchema = {
    type: 'object',
    properties: {
        fileset_id: { type: 'string' },
        file_name: { type: 'string' },
        orig_name: { type: 'string' },
        size: { type: 'number', description: '文件字节数；此接口字段名为 size' },
        share_url: { type: 'string' },
        file_id: { type: 'string' },
        download_url: { type: 'string' },
    },
    required: [
        'fileset_id',
        'file_name',
        'orig_name',
        'size',
        'share_url',
        'file_id',
        'download_url',
    ],
};
