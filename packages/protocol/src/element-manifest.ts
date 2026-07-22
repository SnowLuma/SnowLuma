/**
 * 消息元素「四向」对账清单 —— 单一权威。
 *
 * 一种消息元素（文字/图片/窗口抖动/商城表情…）要在两个流向、共 4 处处理，散在
 * 不同文件、不同包。历史上这 4 处各写各的、没人对账，导致字段名对不上、漏写
 * 方向无人知（都走运行时兜底 `default`，悄悄失败）。
 *
 * 本清单声明「每种元素类型应支持哪几个方向」，配套的两道对账测试
 * （`protocol/tests/element-manifest.test.ts` 与 `onebot/tests/element-manifest.test.ts`，
 * 因包边界拆两处、共用本清单）拿它逐一核对那 4 处代码 —— 漏写或多写一个方向
 * 立即报红，而不再是运行时静默。
 *
 * 四个方向：
 *   D 收·解    QQ 原始数据 → MessageElement    `protocol/msg-push/rich-body-decoder.ts`
 *   S 收·转    MessageElement → OneBot 段        `onebot/event-converter/to-segment.ts`
 *   P 发·解    OneBot 段 → MessageElement        `onebot/message-parser.ts`
 *   W 发·打包  MessageElement → QQ 原始数据      `protocol/element-builder.ts`
 *
 * 注：D（收·解）按 proto 字段分派、一字段可扇出多种元素、多字段可收敛为一种，
 * 与另外三个「按 element.type 分派」的方向异构，故它保持独立开关、不进 onebot
 * 侧的合并表；但它产出的元素类型集合仍受本清单核对。
 *
 * 取值语义：
 *   'yes'          该方向有对应处理。
 *   'no'           该方向暂无（记录在案的缺口，本次重构不补，另立任务再议）。
 *   'by-design-no' 该方向按设计不支持（QQ 协议限制），缺席是正确的。
 */

import type {
  MessageElement,
  MessageElementOf,
  MessageElementType,
} from './events';

export const ELEMENT_DIRECTIONS = ['D', 'S', 'P', 'W'] as const;
export type ElementDirection = (typeof ELEMENT_DIRECTIONS)[number];

export type DirectionSupport = 'yes' | 'no' | 'by-design-no';

/** The outbound transport selected before any resolver, upload, or packet send. */
export type OutboundMessageScene = 'direct-private' | 'group' | 'group-temp' | 'forward';

/**
 * Window shake is an action-like CommonElem, not ordinary message content.
 * Keep its narrow send contract in the protocol package so every caller
 * rejects unsupported destinations and mixed payloads before side effects.
 */
export function assertWindowShakeSendPolicy(
  windowShakeCount: number,
  segmentCount: number,
  scene?: OutboundMessageScene,
): void {
  if (windowShakeCount === 0) return;
  if (scene !== 'direct-private') {
    throw new MessageElementValidationError(
      'UNSENDABLE_TYPE',
      'message element "poke" can only be sent in a direct private chat',
      'poke',
    );
  }
  if (windowShakeCount !== 1 || segmentCount !== 1) {
    throw new MessageElementValidationError(
      'UNSENDABLE_TYPE',
      'message element "poke" must be the only segment in a private window-shake request',
      'poke',
    );
  }
}

type ElementField<T extends MessageElementType> = Exclude<keyof MessageElementOf<T>, 'type'> & string;

export interface ElementSpec<T extends MessageElementType> {
  /** 每个方向的支持状态。 */
  readonly directions: Readonly<Record<ElementDirection, DirectionSupport>>;
  /**
   * 该元素类型允许的全部字段。`fieldsFor` 在编译期要求它与判别联合完全一致，
   * `validateMessageElement` 在运行时据此拒绝越界字段。
   */
  readonly fields: readonly ElementField<T>[];
  /** 运行时必须存在（不能为 undefined/null）的字段。 */
  readonly requiredFields: readonly ElementField<T>[];
  /** 备注：媒体上传、三角映射、协议限制等需要跨方向知道的事。 */
  readonly note?: string;
}

type ManifestShape = { readonly [T in MessageElementType]: ElementSpec<T> };

/**
 * Compile-time exact-field guard: an unknown field is rejected by the tuple's
 * element type; omitting a legal field makes the synthetic __missingFields
 * property unsatisfied. The returned tuple remains available at runtime.
 */
function fieldsFor<T extends MessageElementType>() {
  return <const F extends readonly ElementField<T>[]>(
    fields: F & (Exclude<ElementField<T>, F[number]> extends never
      ? unknown
      : { readonly __missingFields: Exclude<ElementField<T>, F[number]> }),
  ): F => fields;
}

/**
 * 全部规范元素类型 × 四向支持。此表须与那 4 处派发代码逐字一致，否则对账测试报红。
 */
export const ELEMENT_MANIFEST = {
  text: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'text'>()(['text']),
    requiredFields: ['text'],
  },
  at: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'at'>()(['targetUin', 'uid', 'text']),
    requiredFields: ['targetUin'],
  },
  face: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'face'>()(['faceId']),
    requiredFields: ['faceId'],
  },
  reply: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'reply'>()(['replySeq', 'replyMessageId', 'replySenderUin', 'replyTime', 'replyRandom', 'replyElements']),
    requiredFields: ['replySeq'],
  },
  json: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'json'>()(['text']),
    requiredFields: ['text'],
  },
  xml: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'xml'>()(['text', 'subType']),
    requiredFields: ['text'],
  },
  forward: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'forward'>()(['resId', 'forwardSource', 'forwardSummary', 'forwardPrompt', 'forwardNews', 'forwardTSum', 'forwardUuid']),
    requiredFields: ['resId'],
  },
  image: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'image'>()(['imageUrl', 'fileId', 'fileName', 'fileSize', 'url', 'subType', 'summary', 'width', 'height', 'flash', 'md5Hex', 'sha1Hex', 'picFormat', 'noByteFallback']),
    requiredFields: [],
    note: 'media：W（打包）经 highway 上传、异步，需 SendContext',
  },
  record: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'record'>()(['fileName', 'fileId', 'fileSize', 'fileHash', 'url', 'duration', 'md5Hex', 'sha1Hex', 'voiceFormat', 'noByteFallback', 'mediaNode']),
    requiredFields: [],
    note: 'media',
  },
  video: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'video'>()(['fileName', 'fileId', 'fileSize', 'fileHash', 'url', 'thumbUrl', 'duration', 'width', 'height', 'md5Hex', 'sha1Hex', 'videoFormat', 'noByteFallback', 'mediaNode']),
    requiredFields: [],
    note: 'media',
  },
  mface: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'mface'>()(['emojiId', 'emojiPackageId', 'emojiKey', 'text']),
    requiredFields: ['emojiId'],
    note: '商城表情三角：S（转 OneBot）输出 image 段并挂 emoji_id/emoji_package_id/key 标记，P（解）再从该 image 段认回',
  },
  file: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'file'>()(['fileId', 'fileName', 'fileSize', 'fileHash', 'url', 'md5Hex', 'sha1Hex']),
    requiredFields: [],
    note: 'W 特殊：live-send 在 OneBot 层被拆走走独立上传管线，仅 forwardFake 时落 transElem(24)',
  },
  poke: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: fieldsFor<'poke'>()(['subType']),
    requiredFields: ['subType'],
    note: 'W 仅支持普通好友私聊窗口抖动；send_poke Action 仍表示拍一拍',
  },
  markdown: {
    directions: { D: 'no', S: 'no', P: 'yes', W: 'yes' },
    fields: fieldsFor<'markdown'>()(['text']),
    requiredFields: ['text'],
    note: '收侧（D/S）无对应，仅发送方向存在',
  },
  flash_file: {
    directions: { D: 'yes', S: 'yes', P: 'by-design-no', W: 'by-design-no' },
    fields: fieldsFor<'flash_file'>()(['filesetId', 'sceneType', 'fileName']),
    requiredFields: ['filesetId'],
    note: '闪传文件（#199/#200）：旧客户端(≤9.9.30)的 richui markdown 卡片才有；仅收侧解码上报，发送走 send_flash_msg 动作，故 P/W 按设计不支持',
  },
} as const satisfies ManifestShape;

export type ElementType = keyof typeof ELEMENT_MANIFEST;

export type MessageElementValidationCode =
  | 'UNKNOWN_TYPE'
  | 'UNSENDABLE_TYPE'
  | 'MISSING_FIELD'
  | 'UNEXPECTED_FIELD'
  | 'INVALID_FIELD';

/** Stable typed error for callers that map invalid messages to BAD_REQUEST. */
export class MessageElementValidationError extends Error {
  override readonly name = 'MessageElementValidationError';

  constructor(
    readonly code: MessageElementValidationCode,
    message: string,
    readonly elementType?: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type MessageElementValidationResult =
  | { readonly ok: true; readonly element: MessageElement }
  | { readonly ok: false; readonly error: MessageElementValidationError };

const STRING_FIELDS: ReadonlySet<string> = new Set([
  'text', 'uid', 'imageUrl', 'fileId', 'fileName', 'fileHash', 'url',
  'thumbUrl', 'summary', 'emojiId', 'emojiKey', 'resId', 'filesetId',
  'forwardSource', 'forwardSummary', 'forwardPrompt', 'forwardUuid',
  'md5Hex', 'sha1Hex',
]);
const NUMBER_FIELDS: ReadonlySet<string> = new Set([
  'faceId', 'targetUin', 'fileSize', 'replySeq', 'replyMessageId',
  'replySenderUin', 'replyTime', 'replyRandom', 'subType', 'duration',
  'width', 'height', 'emojiPackageId', 'sceneType', 'forwardTSum',
  'picFormat', 'videoFormat', 'voiceFormat',
]);
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(['flash', 'noByteFallback']);

function throwValidation(
  code: MessageElementValidationCode,
  message: string,
  elementType?: string,
  field?: string,
): never {
  throw new MessageElementValidationError(code, message, elementType, field);
}

function validateFieldValue(type: ElementType, field: string, value: unknown): void {
  if (value === undefined) return;
  if (STRING_FIELDS.has(field)) {
    if (typeof value !== 'string') {
      throwValidation('INVALID_FIELD', `message element "${type}" field "${field}" must be a string`, type, field);
    }
    return;
  }
  if (NUMBER_FIELDS.has(field)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throwValidation('INVALID_FIELD', `message element "${type}" field "${field}" must be a safe integer`, type, field);
    }
    return;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof value !== 'boolean') {
      throwValidation('INVALID_FIELD', `message element "${type}" field "${field}" must be a boolean`, type, field);
    }
    return;
  }
  if (field === 'replyElements') {
    if (!Array.isArray(value)) {
      throwValidation('INVALID_FIELD', 'message element "reply" field "replyElements" must be an array', type, field);
    }
    for (const quoted of value) assertValidMessageElement(quoted);
    return;
  }
  if (field === 'forwardNews') {
    if (!Array.isArray(value) || value.some((item) => (
      typeof item !== 'object' || item === null || Array.isArray(item)
      || typeof (item as { text?: unknown }).text !== 'string'
      || Object.keys(item).some((key) => key !== 'text')
    ))) {
      throwValidation('INVALID_FIELD', 'message element "forward" field "forwardNews" must contain only { text: string } entries', type, field);
    }
    return;
  }
  if (field === 'mediaNode') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throwValidation('INVALID_FIELD', `message element "${type}" field "mediaNode" must be an object`, type, field);
    }
    return;
  }
  // This is an invariant failure in the executable contract, not bad user
  // input: adding a manifest field without a runtime validator must be loud.
  throw new Error(`element manifest field has no runtime validator: ${type}.${field}`);
}

function requireNonEmptyString(element: Record<string, unknown>, type: ElementType, field: string): void {
  const value = element[field];
  if (typeof value !== 'string' || value.length === 0) {
    throwValidation('INVALID_FIELD', `message element "${type}" field "${field}" must not be empty`, type, field);
  }
}

function validateSemantics(
  element: MessageElement,
  direction: ElementDirection | undefined,
): void {
  const nonNegativeFields = [
    'targetUin', 'faceId', 'fileSize', 'replySeq',
    'replySenderUin', 'replyTime', 'subType', 'duration', 'width', 'height',
    'emojiPackageId', 'sceneType', 'forwardTSum', 'picFormat', 'videoFormat',
    'voiceFormat',
  ] as const;
  const record = element as unknown as Record<string, unknown>;
  for (const field of nonNegativeFields) {
    const value = record[field];
    if (typeof value === 'number' && value < 0) {
      throwValidation(
        'INVALID_FIELD',
        `message element "${element.type}" field "${field}" must be non-negative`,
        element.type,
        field,
      );
    }
  }
  if (element.md5Hex !== undefined && !/^[0-9a-fA-F]{32}$/.test(element.md5Hex)) {
    throwValidation(
      'INVALID_FIELD',
      `message element "${element.type}" field "md5Hex" must be exactly 32 hexadecimal characters`,
      element.type,
      'md5Hex',
    );
  }
  if (element.sha1Hex !== undefined && !/^[0-9a-fA-F]{40}$/.test(element.sha1Hex)) {
    throwValidation(
      'INVALID_FIELD',
      `message element "${element.type}" field "sha1Hex" must be exactly 40 hexadecimal characters`,
      element.type,
      'sha1Hex',
    );
  }

  switch (element.type) {
    case 'text':
    case 'xml':
    case 'markdown':
      requireNonEmptyString(element as unknown as Record<string, unknown>, element.type, 'text');
      return;
    case 'json': {
      requireNonEmptyString(element as unknown as Record<string, unknown>, element.type, 'text');
      if (direction !== 'P' && direction !== 'W') return;
      try {
        const parsed = JSON.parse(element.text) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      } catch {
        throwValidation(
          'INVALID_FIELD',
          'message element "json" field "text" must contain a JSON object',
          element.type,
          'text',
        );
      }
      return;
    }
    case 'at':
      if (!Number.isInteger(element.targetUin) || element.targetUin < 0) {
        throwValidation('INVALID_FIELD', 'message element "at" field "targetUin" must be a non-negative integer', element.type, 'targetUin');
      }
      return;
    case 'face':
      if (!Number.isInteger(element.faceId) || element.faceId < 0) {
        throwValidation('INVALID_FIELD', 'message element "face" field "faceId" must be a non-negative integer', element.type, 'faceId');
      }
      return;
    case 'reply':
      if (!Number.isInteger(element.replySeq) || element.replySeq <= 0) {
        throwValidation('INVALID_FIELD', 'message element "reply" field "replySeq" must be a positive integer', element.type, 'replySeq');
      }
      return;
    case 'mface':
      if (!/^[0-9a-fA-F]{32}$/.test(element.emojiId)) {
        throwValidation(
          'INVALID_FIELD',
          'message element "mface" field "emojiId" must be exactly 32 hexadecimal characters',
          element.type,
          'emojiId',
        );
      }
      return;
    case 'forward':
      requireNonEmptyString(element as unknown as Record<string, unknown>, element.type, 'resId');
      return;
    case 'image': {
      if (direction !== 'P' && direction !== 'W') return;
      if (element.noByteFallback === true && (!element.md5Hex?.trim() || !element.sha1Hex?.trim())) {
        throwValidation(
          'MISSING_FIELD',
          `message element "${element.type}" with noByteFallback requires md5Hex + sha1Hex`,
          element.type,
          'md5Hex',
        );
      }
      const hasSource = Boolean(element.url?.trim() || element.imageUrl?.trim() || element.fileId?.trim());
      const hasFingerprint = element.noByteFallback === true
        && Boolean(element.md5Hex?.trim() && element.sha1Hex?.trim());
      if (!hasSource && !hasFingerprint) {
        throwValidation(
          'MISSING_FIELD',
          `message element "${element.type}" requires a file/url source or a complete fast-upload fingerprint`,
          element.type,
          'url',
        );
      }
      return;
    }
    case 'record':
    case 'video': {
      if (direction !== 'P' && direction !== 'W') return;
      if (element.noByteFallback === true && (!element.md5Hex?.trim() || !element.sha1Hex?.trim())) {
        throwValidation(
          'MISSING_FIELD',
          `message element "${element.type}" with noByteFallback requires md5Hex + sha1Hex`,
          element.type,
          'md5Hex',
        );
      }
      const hasSource = Boolean(element.url?.trim() || element.fileId?.trim());
      const hasFingerprint = element.noByteFallback === true
        && Boolean(element.md5Hex?.trim() && element.sha1Hex?.trim());
      if (!hasSource && !hasFingerprint) {
        throwValidation(
          'MISSING_FIELD',
          `message element "${element.type}" requires a file/url source or a complete fast-upload fingerprint`,
          element.type,
          'url',
        );
      }
      return;
    }
    case 'file':
      if ((direction === 'P' || direction === 'W') && !element.url?.trim() && !element.fileId?.trim()) {
        throwValidation('MISSING_FIELD', 'message element "file" requires file_id or file/url', element.type, 'fileId');
      }
      return;
    case 'poke':
    case 'flash_file':
      return;
  }
}

/**
 * Validate a runtime value against the same field table checked by TypeScript.
 * P/W additionally enforce sendability and source requirements.
 */
export function assertValidMessageElement(
  value: unknown,
  direction?: ElementDirection,
): asserts value is MessageElement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throwValidation('INVALID_FIELD', 'message element must be an object');
  }
  const element = value as Record<string, unknown>;
  const rawType = element.type;
  if (typeof rawType !== 'string' || !Object.hasOwn(ELEMENT_MANIFEST, rawType)) {
    throwValidation('UNKNOWN_TYPE', `unknown message element type: ${String(rawType)}`, String(rawType));
  }
  const type = rawType as ElementType;
  const spec = ELEMENT_MANIFEST[type];

  if (direction && spec.directions[direction] !== 'yes') {
    const hint = type === 'flash_file'
      ? 'use the send_flash_msg Action instead'
      : `direction ${direction} is not supported`;
    throwValidation('UNSENDABLE_TYPE', `message element "${type}" cannot be sent; ${hint}`, type);
  }

  const allowed = new Set<string>(['type', ...spec.fields]);
  for (const key of Object.keys(element)) {
    if (!allowed.has(key)) {
      throwValidation('UNEXPECTED_FIELD', `message element "${type}" does not allow field "${key}"`, type, key);
    }
  }
  for (const field of spec.requiredFields) {
    if (element[field] === undefined || element[field] === null) {
      throwValidation('MISSING_FIELD', `message element "${type}" requires field "${field}"`, type, field);
    }
  }
  for (const field of spec.fields) validateFieldValue(type, field, element[field]);
  validateSemantics(element as unknown as MessageElement, direction);
}

export function validateMessageElement(
  value: unknown,
  direction?: ElementDirection,
): MessageElementValidationResult {
  try {
    assertValidMessageElement(value, direction);
    return { ok: true, element: value };
  } catch (error) {
    if (error instanceof MessageElementValidationError) return { ok: false, error };
    throw error;
  }
}

export function assertValidMessageElements(
  values: readonly unknown[],
  direction?: ElementDirection,
): asserts values is readonly MessageElement[] {
  for (const value of values) assertValidMessageElement(value, direction);
}

/**
 * 某方向应被处理的元素类型集合（`directions[dir] === 'yes'`）—— 对账测试的基准。
 */
export function typesForDirection(dir: ElementDirection): Set<string> {
  const out = new Set<string>();
  for (const [type, spec] of Object.entries(ELEMENT_MANIFEST)) {
    if (spec.directions[dir] === 'yes') out.add(type);
  }
  return out;
}

/**
 * 发·解（P）侧还识别一批「纯 OneBot 输入词」：可执行的会塌缩成 json / face，
 * node 仅允许在 forward node list 的专用解析器中使用，shake 会规范化为 poke，
 * anonymous 因没有合法消息元素语义而返回 typed validation error。它们没有收侧
 * 对应，也没有专属 wire 形态，故不进本清单；对账 P 时须先从代码里剔除这些类型。
 */
export const INPUT_SUGAR_SEGMENTS: ReadonlySet<string> = new Set([
  'node', 'share', 'music', 'location', 'contact', 'rps', 'dice', 'shake', 'anonymous',
]);
