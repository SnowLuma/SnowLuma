# 群邀请与入群身份

成员 A 邀请 B，管理员 C 审批时，邀请人、入群者与处理者是三个独立身份。
不要把 `group_increase.operator_id` 当成邀请人，也不要仅凭 `sub_type: invite` 推断两者相同。

## 入群通知

`group_increase` 保留原有的 `user_id`、`operator_id` 和 `sub_type`，增加：

| 字段 | 含义 |
| --- | --- |
| `invitor_id` | QQ 明确提供的独立邀请人 QQ 号；无法确定时为 `0` |
| `invitor_status` | `known` 表示邀请人 QQ 号已知；`unknown` 表示无法确定 |

部分审批入群推送提供独立邀请人信息，SnowLuma 从该推送读取并解析身份。
二维码分享者与邀请人分开处理；旧式推送、自身入群通知或缺少来源信息的通知保留 `unknown`。
不会按同群、同成员或时间接近程度猜测邀请关系，也不会用操作者填充邀请人。
身份查询失败会留下日志，入群事件仍按现有策略上报，未知邀请人不阻断通知。

## 群申请列表

`get_group_system_msg` 返回的每条记录增加以下字段：

| 字段 | 含义 |
| --- | --- |
| `target_uin`、`target_nick` | 申请或被邀请入群者，始终表示 B |
| `operator_uin`、`operator_nick` | 处理该申请的操作者；审批场景中表示 C |
| `target_status`、`invitor_status`、`operator_status` | 对应 QQ 号为 `known` 或 `unknown` |

原有 `invitor_uin`、`invitor_nick` 表示 A。`requester_uin` 保持兼容：普通申请表示申请人，
邀请登录账号入群的记录则表示邀请人。需要区分三方时，应使用 `target_uin`、`invitor_uin`、`operator_uin`。
QQ 只提供 UID 时会查询对应 QQ 号，查询去重并限制并发；查询错误会返回接口错误，不伪装成空列表。

```json
{
    "target_uin": 10002,
    "target_status": "known",
    "invitor_uin": 10004,
    "invitor_status": "known",
    "operator_uin": 10003,
    "operator_status": "known",
    "checked": true
}
```

**`0` 或 `unknown` 不代表“没有邀请人”。** QQ 未提供身份、记录不可见、身份尚未解析等情况均不能证明没有邀请人。
当前已确认的字段不足以对缺失信息可靠作出“无邀请人”的判断，因此不输出这种推断。
同样，`checked: true` 只表示已处理，不代表必然审批通过；`operator_uin` 也可能是拒绝请求的人。

`count` 限制每个收件箱读取的记录数（最多 100）；`group_id` 在读取后过滤，
并非查询指定群的完整历史。`only_pending` 默认为 `false`。空数组表示本次读取范围内没有匹配记录，
不能证明某次入群没有邀请人。调试日志会分别记录收件箱数量、类型筛选和最终筛选数量。

SDK 的 `getGroupSystemMessages()` 提供相应类型。新增字段在 SDK 中可选，以兼容旧服务端；
连接旧服务端时，缺失的状态也应视为未知。
