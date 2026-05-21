# V2.0.0 前计划
- [x] 统一Uid/Uin提供一个Service，并实现Sqlite持久化，群/好友/入群和好友申请 获取新Uid。
- [x] 优化Debug体验，实现免打包Debug，同时数据目录正确。（Proton兜底思路改成ts+map提取类型，用于tsx和nodejs，vite正常打包的时候剥离）
- [x] 拆分core，架构为Common（公共能力） OneBot（外层封装 协议转换），Core（Api raw能力，基础能力等功能），Bridge（封装和关键解析能力和Event message/sent group/member_add ...）
- [x] 剥离ProtocolBuffer定义到单独package。
- [x] 整理发送和解析消息链路，提高性能。`packages/{bridge,onebot}/bench/*.bench.ts` 拿到了基线数字。最大瓶颈不在 protobuf 解析（已经 sub-μs），而在两处 SQLite 反复 `db.prepare(sql)` 重 parse —— 把 `node:sqlite`（实验性）换成 `better-sqlite3`（稳定）+ 缓存 prepared statements 后：`group_member_join` 全链路 17.5μs → 4.7μs（**3.7x**），`storeMeta` 17μs → 11μs，`storeEvent` 23μs → 18μs，`findMeta` 5.4μs → 1.3μs（**4x**）。送侧组合 hot path（storeMeta + storeEvent）单条消息 40μs → 29μs。另外干掉 `Buffer.from(pkt.body)` 的冗余 alloc（pkt.body 本来就是 Uint8Array）。`elementsToJson` 同步快路径 / WAL checkpoint 调参 / JSON 序列化替换 等次要优化点保留，待真有 throughput 压力再做。
- [x] 对齐NapCat设计采用Api层，挂到ctx，Core与Onebot都这么设计。
  - [x] Core 侧：13 个 Api 类（message/contacts/groupAdmin/groupFile/groupAlbum/interaction/friend/profile/forward/misc/extras/web）已挂到 `bridge.apis.<area>.method()`，`BridgeInterface` + `actions/*` 全部删除。
  - [x] OneBot 侧：`ApiActionContext` 砍掉 ~40 个纯转发字段（groupAdmin / groupFile / groupAlbum / friend / interaction / message / profile / web 八区），actions 直接 `ctx.bridge.apis.<area>.method(...)` 调用 Core 的 Api 层。保留的 ~30 个字段全是真组合 helper（module-level send/forward、message store reads、meta-lookup composers）。完全 NapCat 化（class-per-action / TypeBox schema / actionName 枚举 / auto-register decorator）暂未做——profile 文档/工具链需求出现后再做。
