/**
 * 消息元素「四向」对账清单 —— 单一权威。
 *
 * 一种消息元素（文字/图片/戳一戳/商城表情…）要在两个流向、共 4 处处理，散在
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

export const ELEMENT_DIRECTIONS = ['D', 'S', 'P', 'W'] as const;
export type ElementDirection = (typeof ELEMENT_DIRECTIONS)[number];

export type DirectionSupport = 'yes' | 'no' | 'by-design-no';

export interface ElementSpec {
  /** 每个方向的支持状态。 */
  readonly directions: Readonly<Record<ElementDirection, DirectionSupport>>;
  /**
   * 该元素类型在 `MessageElement` 上「属于自己」的字段 —— 字段契约的文档基准，
   * 供各方向读写时对齐（例如 poke 统一用 `subType`，不再收侧 `subType` / 发侧
   * `faceId` 打架）。当前为文档性声明，字段级强制留待后续阶段。
   */
  readonly fields: readonly string[];
  /** 备注：媒体上传、三角映射、协议限制等需要跨方向知道的事。 */
  readonly note?: string;
}

/**
 * 全部规范元素类型 × 四向支持。此表须与那 4 处派发代码逐字一致，否则对账测试报红。
 */
export const ELEMENT_MANIFEST = {
  text: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['text'],
  },
  at: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['targetUin', 'uid', 'text'],
  },
  face: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['faceId'],
  },
  reply: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['replySeq', 'replyMessageId', 'replySenderUin', 'replyTime', 'replyRandom', 'replyElements'],
  },
  json: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['text'],
  },
  xml: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['text', 'subType'],
  },
  forward: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['resId', 'forwardSource', 'forwardSummary', 'forwardPrompt', 'forwardNews', 'forwardTSum', 'forwardUuid'],
  },
  image: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['imageUrl', 'fileId', 'fileName', 'fileSize', 'url', 'subType', 'summary', 'width', 'height', 'flash', 'md5Hex', 'sha1Hex', 'picFormat', 'noByteFallback', 'mediaNode'],
    note: 'media：W（打包）经 highway 上传、异步，需 SendContext',
  },
  record: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['fileName', 'fileId', 'url', 'duration', 'fileSize', 'md5Hex', 'sha1Hex', 'voiceFormat', 'noByteFallback', 'mediaNode'],
    note: 'media',
  },
  video: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['fileName', 'fileId', 'url', 'thumbUrl', 'thumbFileId', 'duration', 'width', 'height', 'fileSize', 'md5Hex', 'sha1Hex', 'videoFormat', 'noByteFallback', 'mediaNode'],
    note: 'media',
  },
  mface: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['emojiId', 'emojiPackageId', 'emojiKey', 'text', 'summary'],
    note: '商城表情三角：S（转 OneBot）输出 image 段并挂 emoji_id/emoji_package_id/key 标记，P（解）再从该 image 段认回',
  },
  file: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'yes' },
    fields: ['fileId', 'thumbFileId', 'fileName', 'fileSize', 'url', 'fileHash', 'md5Hex', 'sha1Hex', 'resId'],
    note: 'W 特殊：live-send 在 OneBot 层被拆走走独立上传管线，仅 forwardFake 时落 transElem(24)',
  },
  poke: {
    directions: { D: 'yes', S: 'yes', P: 'yes', W: 'by-design-no' },
    fields: ['subType'],
    note: 'QQ 不允许戳一戳当消息段发送，故 W（打包）按设计不支持；戳一戳作为独立动作走 OIDB send-poke，与本表无关。字段契约以收侧既有 subType 为准',
  },
  markdown: {
    directions: { D: 'no', S: 'no', P: 'yes', W: 'yes' },
    fields: ['text'],
    note: '收侧（D/S）无对应，仅发送方向存在',
  },
} as const satisfies Record<string, ElementSpec>;

export type ElementType = keyof typeof ELEMENT_MANIFEST;

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
 * 发·解（P）侧还接收一批「纯 OneBot 输入糖」：它们不是某种真实消息元素，只是被
 * 塌缩成 json / face / poke 的输入便利（如骰子、猜拳、位置/音乐/名片分享、转发
 * node、匿名标记），没有收侧对应，也没有专属的 wire 形态，故不进本清单。对账 P
 * 时须先从代码里剔除这些类型。
 */
export const INPUT_SUGAR_SEGMENTS: ReadonlySet<string> = new Set([
  'node', 'share', 'music', 'location', 'contact', 'rps', 'dice', 'shake', 'anonymous',
]);
