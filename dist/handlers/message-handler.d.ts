/**
 * Message handler — adapted for SnowLuma SDK.
 *
 * 将原 NapCat 的 `ctx.actions.call(...)` 调用迁移到 SnowLuma SDK 的类型化方法：
 *  - send_msg               → bot.sendGroupMessage / bot.sendPrivateMessage
 *  - send_group_forward_msg → bot.sendForwardMessage({ group_id, messages, ...preview })
 *  - send_private_forward_msg → bot.sendForwardMessage({ user_id, messages, ...preview })
 *  - send_forward_msg (兼容回退) → bot.raw('send_forward_msg', { group_id, messages, ...preview })
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Author: 希儿 (shiYuPIay) / SnowLuma 适配
 */
import type { SnowLumaApiClient } from '@snowluma/sdk/client';
import type { OneBotMessageEvent } from '@snowluma/sdk/types';
/**
 * 主消息处理函数。由 SnowLuma WebSocket 客户端的 onMessage 事件触发。
 */
export declare function handleMessage(bot: SnowLumaApiClient, event: OneBotMessageEvent): Promise<void>;
/** 清空限流记录（用于热重载/测试）。 */
export declare function resetRateLimit(): void;
//# sourceMappingURL=message-handler.d.ts.map