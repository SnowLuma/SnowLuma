import { defineAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import type { JsonValue } from '../types';
import { RETCODE, failedResponse, okResponse } from '../types';

export const actions = [
  // get_qzone_msg_list — 获取 QQ 空间说说列表。无 go-cqhttp 标准，自定义命名。
  // 默认取机器人自己的空间；传 target_uin 可查看指定账号（需有权限）。
  // 复用 qzone.qq.com 的 cookie/g_tk 基建（与群相册同源），纯 web，无 trpc。
  defineAction({
    name: 'get_qzone_msg_list',
    readOnly: true,
    summary: '获取 QQ 空间说说列表（默认机器人自己的空间）',
    params: {
      target_uin: f.uint().describe('目标 QQ 号，省略则取机器人自己').optional(),
      pos: f.int({ min: 0 }).describe('起始偏移').default(0),
      num: f.int({ min: 1, max: 100 }).describe('本页数量').default(20),
    },
    run: async (p, ctx) => {
      try {
        const res = await ctx.bridge.apis.qzone.getMsgList(p.target_uin, p.pos, p.num);
        return okResponse(res as unknown as JsonValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to get qzone msg list';
        return failedResponse(RETCODE.INTERNAL_ERROR, message);
      }
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
