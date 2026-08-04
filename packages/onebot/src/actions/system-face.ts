import { isSuperFaceEntry } from '@snowluma/protocol/oidb-services/sys-faces/fetch-sys-faces';
import type { SysFaceEntry } from '@snowluma/protocol/sys-face-store';
import { defineAction, f } from '../action-kit';
import { okResponse, type JsonObject } from '../types';

function faceEntry(face: SysFaceEntry): JsonObject {
  return {
    q_sid: face.qSid,
    q_des: face.qDes,
    em_code: face.emCode,
    q_cid: face.qCid,
    ani_sticker_type: face.aniStickerType,
    ani_sticker_pack_id: face.aniStickerPackId,
    ani_sticker_id: face.aniStickerId,
    url: face.url,
    emoji_name_alias: face.emojiNameAlias,
    ani_sticker_width: face.aniStickerWidth,
    ani_sticker_height: face.aniStickerHeight,
    is_super: isSuperFaceEntry(face),
  };
}

const refreshField = () => f.bool().default(false).describe('是否强制从 QQ 刷新目录');
const faceIdField = () => f.faceId().describe('QQ 系统表情编号');
const nullableInteger = { type: ['integer', 'null'] };
const nullableString = { type: ['string', 'null'] };
const faceSchema = {
  type: 'object',
  properties: {
    q_sid: { type: 'string', description: '表情编号' },
    q_des: { type: 'string', description: '表情描述' },
    em_code: { type: 'string' },
    q_cid: nullableInteger,
    ani_sticker_type: nullableInteger,
    ani_sticker_pack_id: nullableInteger,
    ani_sticker_id: nullableInteger,
    url: nullableString,
    emoji_name_alias: { type: 'array', items: { type: 'string' } },
    ani_sticker_width: nullableInteger,
    ani_sticker_height: nullableInteger,
    is_super: { type: 'boolean', description: '是否使用超级表情格式' },
  },
  required: [
    'q_sid', 'q_des', 'em_code', 'q_cid', 'ani_sticker_type',
    'ani_sticker_pack_id', 'ani_sticker_id', 'url', 'emoji_name_alias',
    'ani_sticker_width', 'ani_sticker_height', 'is_super',
  ],
};

export const actions = [
  defineAction({
    name: 'fetch_sys_faces',
    summary: '获取 QQ 系统表情目录',
    readOnly: true,
    returns: '按分组返回完整的 QQ 系统表情映射。',
    returnsSchema: {
      type: 'object',
      properties: {
        packs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pack_name: { type: 'string' },
              emojis: { type: 'array', items: faceSchema },
            },
            required: ['pack_name', 'emojis'],
          },
        },
      },
      required: ['packs'],
    },
    params: { refresh: refreshField() },
    run: async (params, ctx) => {
      const packs = await ctx.bridge.apis.systemFace.fetchCatalog(params.refresh);
      return okResponse({
        packs: packs.map((pack) => ({
          pack_name: pack.packName,
          emojis: pack.emojis.map(faceEntry),
        })),
      });
    },
  }),

  defineAction({
    name: 'fetch_face_entity',
    summary: '按编号查询 QQ 系统表情',
    readOnly: true,
    returns: '表情详情；编号不存在时返回 null。',
    returnsSchema: { anyOf: [faceSchema, { type: 'null' }] },
    params: {
      face_id: faceIdField(),
      refresh: refreshField(),
    },
    run: async (params, ctx) => {
      const face = await ctx.bridge.apis.systemFace.fetchFace(params.face_id, params.refresh);
      return okResponse(face ? faceEntry(face) : null);
    },
  }),

  defineAction({
    name: 'search_sys_faces',
    summary: '搜索 QQ 系统表情',
    readOnly: true,
    returns: '匹配编号、名称、别名或分组名的表情列表。',
    returnsSchema: {
      type: 'object',
      properties: { faces: { type: 'array', items: faceSchema } },
      required: ['faces'],
    },
    params: {
      query: f.string({ allowEmpty: false }).describe('编号、名称、别名或分组名'),
    },
    run: async (params, ctx) => okResponse({
      faces: (await ctx.bridge.apis.systemFace.search(params.query)).map(faceEntry),
    }),
  }),

  defineAction({
    name: 'fetch_super_face_id',
    summary: '判断 QQ 系统表情是否使用超级表情格式',
    readOnly: true,
    returns: '是否使用超级表情格式。',
    returnsSchema: {
      type: 'object',
      properties: { is_super: { type: 'boolean' } },
      required: ['is_super'],
    },
    params: {
      face_id: faceIdField(),
      refresh: refreshField(),
    },
    run: async (params, ctx) => okResponse({
      is_super: await ctx.bridge.apis.systemFace.isSuper(params.face_id, params.refresh),
    }),
  }),
];
