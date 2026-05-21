# V2.0.0 前计划
- [x] 统一Uid/Uin提供一个Service，并实现Sqlite持久化，群/好友/入群和好友申请 获取新Uid。
- [x] 优化Debug体验，实现免打包Debug，同时数据目录正确。（Proton兜底思路改成ts+map提取类型，用于tsx和nodejs，vite正常打包的时候剥离）
- [x] 拆分core，架构为Common（公共能力） OneBot（外层封装 协议转换），Core（Api raw能力，基础能力等功能），Bridge（封装和关键解析能力和Event message/sent group/member_add ...）
- [x] 剥离ProtocolBuffer定义到单独package。
- [ ] 整理发送和解析消息链路，提高性能。
- [~] 对齐NapCat设计采用Api层，挂到ctx，Core与Onebot都这么设计。
  - [x] Core 侧：13 个 Api 类（message/contacts/groupAdmin/groupFile/groupAlbum/interaction/friend/profile/forward/misc/extras/web）已挂到 `bridge.apis.<area>.method()`，`BridgeInterface` + `actions/*` 全部删除。
  - [ ] OneBot 侧：仍用 `ApiActionContext` 注入函数 + `ctx.bridge.apis.*` 直调，没有独立的 OneBot Api 类层。
