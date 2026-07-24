## 概述 (Overview)

修复群加群申请（Add Request）在 OIDB `0x10C0` 到 `0x10C8` 审批链路中的 `eventType` 错位映射 Bug。

## 问题原因 (Root Cause)

1. 在底层 OIDB `0x10C0` 协议响应中，字段 2（`eventType`）返回的已是底层的操作类型（`1` = 主动申请加群，`2` = 邀请加群）。
2. 旧代码中 `groupRequestOperationType` 误将其当成 NTQQ 前端 UI 层的 `SysNotifyType` 进行了二次映射（`1 -> 2`，`7 -> 1`），导致原本为 `1` 的主动加群申请被错误改写为 `eventType = 2`（邀请）。
3. 进而导致构造的 `flag`（如 `slreq:1:...:2:0`）在调用 `set_group_add_request`（`0x10C8`）时以 `eventType = 2` 提交审批，腾讯服务端因记录类型不匹配而报错 `OIDB error 120162007 on 0x10c8_1: already deleted by system`。
4. 同时，`groupRequestActor` 和 `GroupRequestPoller` 误将 `notifyType = 1` 当成邀请，导致加群申请的 `requester_uin` 被错误取成 `invitorUin`（0）。

## 解决方案 (Changes)

1. **`fetch-group-requests.ts`**：修正 `groupRequestOperationType`，直接保留底层的 `eventType`（`1` / `2` / `22`），并兼容处理可能传入的高层通知类型 `7 -> 1`。
2. **`contacts.ts`**：规范解析 0x10C0 响应中的 `eventType`，避免错误转表。
3. **`contact-actions.ts` & `group-request-poller.ts`**：修正 `groupRequestActor` 和 `toEvent` 的判断逻辑，仅在 `eventType` 为 `2` 或 `22` 时按邀请处理（提取 `invitor`），其余按申请处理（提取 `target`）。
4. **测试**：补全并更新单元测试用例，覆盖 `eventType: 1` 和 `eventType: 2` 的各种场景。

## 验证 (Verification)

- [x] `pnpm typecheck` 全部通过。
- [x] 单元测试 `fetch-group-requests.test.ts`、`contact-actions.test.ts`、`group-request-poller.test.ts`、`instance-context.test.ts`、`contacts.test.ts` 全部通过。
- [x] 在真实 Docker 容器环境中测试小号主动申请加群，成功生成 `slreq:1:...:1:0` 并通过 `set_group_add_request` 成功审批入群。
