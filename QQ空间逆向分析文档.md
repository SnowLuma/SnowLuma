# QQ 空间（Qzone）原始请求逆向分析文档

本文档客观记录 SnowLuma 中 QQ 空间（Qzone）相关功能的原始网络请求格式：URL、Query 参数、Form 表单字段、请求头、响应结构。所有信息均从源码 [`packages/protocol/src/web/qzone.ts`](packages/protocol/src/web/qzone.ts)（共 1461 行）提取，并标注源码注释中明确说明的"未真机核实 / 待实拍确认"事项。

文中以 `<bkn>`、`<uin>`、`<tid>` 等尖括号表示占位符。

---

## 一、通用前置

### 1.1 Cookie 来源

所有 Qzone 请求都依赖 `qzone.qq.com` 域的 cookie 罐。获取链路见 [`packages/core/src/bridge/apis/web.ts`](packages/core/src/bridge/apis/web.ts:247)：

1. 通过 NTQQ 协议取 `clientkey`。
2. 拼接跳转 URL：`https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=<uin>&clientkey=<clientkey>&u1=<encoded h5.qzone.qq.com url>&keyindex=<keyindex>`。
3. 走 `HttpsGetCookies` 跟随重定向链收集 `Set-Cookie`，得到 `skey` 等。
4. 再通过 `getPSkey(bridge, ['qzone.qq.com'])` 取 `p_skey` 存入 cookie 罐。

最终 cookie 罐中与 Qzone 相关的关键键为：`skey`（或 `p_skey`）、`uin`、`p_uin` 等。

### 1.2 g_tk / bkn 算法

Qzone 的 CSRF 令牌 `g_tk`（也叫 `bkn`）由 `skey`（优先 `p_skey`）经 djb2 哈希截断 31 位得到，实现在 [`packages/protocol/src/web/request-util.ts`](packages/protocol/src/web/request-util.ts:671)：

```
hash = 5381
for each char c of (p_skey || skey):
    hash += (hash << 5) + charCodeAt(c)
return hash & 0x7FFFFFFF        // 无符号 31 位，转为字符串
```

几乎所有 Qzone CGI 都在 Query 中携带 `g_tk=<bkn>`。

### 1.3 统一网关

除图片上传外，其余请求一律走 h5 网关转发：`https://h5.qzone.qq.com/proxy/domain/<真实域名>/<路径>`。原因是 `qzone.qq.com` 的 cookie 罐只在代理源站下才能通过 referer / 同源校验，直连真实域名（如 `ic2.qzone.qq.com`）会失败。

### 1.4 请求工具与公共头

所有请求经由 `RequestUtil.HttpGetText(url, method, body, headers)`（[`packages/protocol/src/web/request-util.ts`](packages/protocol/src/web/request-util.ts:644)）：

- 内部实为 `HttpGetJson` 的文本模式，最大重定向 5 次。
- Cookie 头格式：`Cookie: k=v; k=v; ...`（`cookieToString`，[`packages/protocol/src/web/request-util.ts`](packages/protocol/src/web/request-util.ts:664)）。
- POST 请求统一 `Content-Type: application/x-www-form-urlencoded`，body 为表单编码字符串。

### 1.5 响应解析

响应可能是裸 JSON，也可能是 JSONP 回调包裹（`_preloadCallback({...});` / `callback({...})` / `frameElement.callback({...});`）。`parseQzoneJson`（[`packages/protocol/src/web/qzone.ts`](packages/protocol/src/web/qzone.ts:76)）按"首个 `{` 到末个 `}` 直接 JSON.parse → `back({...})` 整体 → `back(...)` 内取 `{}`"三层回退解析。

好友动态接口（`feeds3_html_more`）例外：其返回是 JS 对象字面量（未加引号 key、单引号字符串、`\xNN` 转义、字面 `undefined`），`JSON.parse` 会失败，必须用专用解析器 `parseQzoneCallback` 当作数据递归下降（不执行代码，防 RCE），见 [`packages/protocol/src/web/qzone.ts`](packages/protocol/src/web/qzone.ts:231)。

---

## 二、说说列表（读）

### 2.1 主路由（默认）

- 方法：`GET`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=<targetUin>&ftype=0&sort=0&pos=<pos>&num=<num>&replynum=100&g_tk=<bkn>&callback=_preloadCallback&code_version=1&format=jsonp&need_private_comment=1
```

Query 参数（源码 [`legacyMsgListRoute`](packages/protocol/src/web/qzone.ts:317)）：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `uin` | targetUin | 目标空间主人 QQ 号 |
| `ftype` | `0` | 说说类型过滤 |
| `sort` | `0` | 排序方式 |
| `pos` | 数字 | 分页偏移 |
| `num` | 数字 | 每页数量（默认 20） |
| `replynum` | `100` | 附带回复数 |
| `g_tk` | bkn | CSRF 令牌 |
| `callback` | `_preloadCallback` | JSONP 回调名 |
| `code_version` | `1` | 协议版本 |
| `format` | `jsonp` | 响应格式 |
| `need_private_comment` | `1` | 需要私密评论 |

- 请求头：`Cookie: <cookie 罐>`

### 2.2 降级路由（-10000 风控时重试一次）

当主路由返回 `code = -10000`（「使用人数过多」），自动重试一次走该路由（源码 [`userMsgListRoute`](packages/protocol/src/web/qzone.ts:347)）：

```
https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=<targetUin>&ftype=0&sort=0&pos=<pos>&num=<num>&g_tk=<bkn>&code_version=1&format=json
```

注意：代理域名是 `taotao.qq.com`（不是 `taotao.qzone.qq.com`），`format=json`（非 jsonp），无 `callback`。请求头额外带 `Referer: https://user.qzone.qq.com/<targetUin>`。实拍显示该路由不受 `-10000` 限流。

### 2.3 响应结构（原始）

```
{
  "code": 0,
  "subcode": 0,
  "message": "",
  "total": <说说总数>,
  "msglist": [
    {
      "tid": "<说说id>",
      "content": "<正文>",
      "created_time": <unix秒>,
      "cmtnum": <评论数>,
      "secret": <0或1>,
      "pic": [
        { "url1": "...", "url2": "...", "url3": "...", "smallurl": "..." }
      ]
    }
  ]
}
```

### 2.4 归一化映射（`mapMsgList`，[`qzone.ts`](packages/protocol/src/web/qzone.ts:296)）

| OneBot 字段 | 原始字段 | 处理 |
| --- | --- | --- |
| `tid` | `tid` | 转字符串 |
| `content` | `content` | 原文 |
| `time` | `created_time` | 转数字 |
| `comment_num` | `cmtnum` | 转数字 |
| `is_private` | `secret` | `!= 0` 即为私密 |
| `images` | `pic[]` | 每张取 `url3 ?? url2 ?? url1 ?? smallurl`（最大变体），空值过滤 |

错误语义：非零 `code` 直接抛错（cookie 失效 / 无权限）；`msglist` 非数组也抛错（区分"空空间 `msglist: []`"与"cookie 失效"）。

---

## 三、好友动态（读）

### 3.1 请求

- 方法：`GET`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?uin=<selfUin>&scope=0&view=1&filter=all&flag=1&applist=all&pagenum=<pageNum>&count=<count>&aisortEndTime=0&aisortOffset=0&aisortBeginTime=0&begintime=0&g_tk=<bkn>&callback=_preloadCallback&format=jsonp&useutf8=1&outputhtmlfeed=1
```

Query 参数（源码 [`getQzoneFeeds`](packages/protocol/src/web/qzone.ts:541)）：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `uin` | selfUin | 机器人自己的 QQ 号（动态以自身身份拉取） |
| `scope` | `0` | 范围 |
| `view` | `1` | 视图 |
| `filter` | `all` | 过滤条件 |
| `flag` | `1` | 标志 |
| `applist` | `all` | 应用列表 |
| `pagenum` | 数字（默认 1） | 页码（1 起） |
| `count` | 数字（默认 10） | 每页条数 |
| `aisortEndTime` | `0` | AI 排序结束时间 |
| `aisortOffset` | `0` | AI 排序偏移 |
| `aisortBeginTime` | `0` | AI 排序开始时间 |
| `begintime` | `0` | 时间游标 |
| `g_tk` | bkn | CSRF 令牌 |
| `callback` | `_preloadCallback` | JSONP 回调名 |
| `format` | `jsonp` | 响应格式 |
| `useutf8` | `1` | UTF-8 |
| `outputhtmlfeed` | `1` | 输出预渲染 HTML |

- 请求头：`Cookie: <cookie 罐>`

分页注意（源码注释）：该 CGI 可靠的深分页由时间游标（`begintime`/`externparam`/`usertime` 逐页带出）驱动，当前实现未透传，因此 `pageNum` 仅第一页可靠，`has_more` 只表示"后面还有"，不代表能稳定取第 2 页。游标分页待实拍确认后补充。

### 3.2 响应结构（原始，JS 字面量）

```
{
  code: 0,
  subcode: 0,
  message: "",
  data: {
    data: [
      {
        uin: <作者QQ>,
        nickname: "<昵称>",
        abstime: <unix秒>,
        appid: <应用id>,
        key: "<feed句柄>",
        feedskey: "<旧别名>",
        html: "<预渲染HTML>"
      },
      undefined,   // 数组尾部存在 undefined 空洞
      ...
    ],
    hasmore: <0或1>
  }
}
```

### 3.3 归一化映射（`mapFeeds`，[`qzone.ts`](packages/protocol/src/web/qzone.ts:491)）

| OneBot 字段 | 原始字段 | 处理 |
| --- | --- | --- |
| `uin` | `uin` | 转数字 |
| `nickname` | `nickname` | 原文 |
| `time` | `abstime` | 转数字 |
| `appid` | `appid` | 转数字（311=说说，4=相册，…） |
| `key` | `key ?? feedskey` | feed 句柄 |
| `html` | `html` | 预渲染 HTML 原样透传 |
| `has_more` | `data.hasmore` | `!= 0` |

---

## 四、发表说说（写）

### 4.1 请求

- 方法：`POST`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=<bkn>
```

- Form body（源码 [`publishQzoneMsg`](packages/protocol/src/web/qzone.ts:679)）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `syn_tweet_verson` | `1` | （注意拼写即如此） |
| `paramstr` | `1` | |
| `pic_template` | `''` | 图片模板 |
| `richtype` | `1` 或 `''` | 带图时为 `1` |
| `richval` | 字符串 | 带图时传 `uploadQzoneImage` 返回的 richval（多图以 `\t` 拼接） |
| `special_url` | `''` | |
| `subrichtype` | `''` | |
| `con` | `<content>` | 说说正文 |
| `feedversion` | `1` | |
| `ver` | `1` | |
| `ugc_right` | `1/4/16/64/128` | 查看权限 |
| `to_sign` | `0` | |
| `who` | `1` | |
| `hostuin` | `<hostUin>` | 发表者（机器人自己） |
| `code_version` | `1` | |
| `format` | `json` | |
| `qzreferrer` | `https://user.qzone.qq.com/<hostUin>` | 来源页 |
| `allow_uins` | 可选 | 仅 `ugc_right=16`（可见名单）或 `128`（不可见名单）时必填，`|` 分隔的 QQ 号去重后拼接 |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

权限值语义：`1`=所有人可见，`4`=好友可见，`16`=部分好友可见（需 `allow_uins`），`64`=仅自己可见，`128`=部分好友不可见（需 `allow_uins`）。

### 4.2 响应结构（原始）

```
{
  "code": 0,
  "subcode": 0,
  "message": "",
  "t1_tid": "<新说说id>",   // 成功时的主字段
  "t1_time": "<unix秒字符串>", // 时间（字符串）
  "tid": "<备用>",           // 防御性回退字段
  "now": <unix秒>            // 备用
}
```

源码说明：publish_v6 成功包把新 feed id 命名为 `t1_tid`、时间命名为 `t1_time`（后者为字符串）；`tid`/`now` 仅作防御性回退。归一化后返回 `{ tid: t1_tid ?? tid, time: Number(t1_time ?? now ?? 0) }`。非零 `code` 或缺少 tid 均抛错。

---

## 五、删除说说（写）

### 5.1 请求

- 方法：`POST`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=<bkn>
```

- Form body（源码 [`deleteQzoneMsg`](packages/protocol/src/web/qzone.ts:758)）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `hostuin` | `<hostUin>` | 说说主人（必须是自己，服务端拒绝他人 tid） |
| `tid` | `<tid>` | 要删除的说说 id |
| `t1_source` | `1` | |
| `code_version` | `1` | |
| `format` | `fs` | **注意：删除用 `format=fs` 而非 `json`**（社区可用脚本确认） |
| `qzreferrer` | `https://user.qzone.qq.com/<hostUin>` | |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

### 5.2 响应

成功无正向负载，`code=0` 且 `subcode=0`（或缺省）即成功；非零 `code`/`subcode` 抛错。源码注释标注：删除的成功字段（`code`/`subcode`）是从同级 CGI 外推的，公开实现仅检查 HTTP 2xx，待实拍确认失败包结构。

---

## 六、点赞 / 取消赞（写）

### 6.1 请求

- 方法：`POST`
- 点赞 URL：

```
https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=<bkn>
```

- 取消赞 URL（源码标注未真机核实，属惯例配对 CGI 的推断）：

```
https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_unlike_app?g_tk=<bkn>
```

- Form body（源码 [`setQzoneLike`](packages/protocol/src/web/qzone.ts:841)）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `qzreferrer` | `https://user.qzone.qq.com/<opUin>` | 点赞者（机器人自己）空间 |
| `opuin` | `<opUin>` | 点赞者 QQ |
| `unikey` | `http://user.qzone.qq.com/<targetUin>/mood/<tid>` | **http 而非 https**，指向被赞说说的 mood feed |
| `curkey` | 同上 | |
| `appid` | `311` | 说说应用 id |
| `typeid` | `0` | |
| `abstime` | `<unix秒>` | 目标说说的发表时间（来自列表/动态）；未知传 `0` |
| `fid` | `<tid>` | 说说 id |
| `from` | `1` | |
| `active` | `0` | |
| `fupdate` | `1` | |
| `format` | `json` | |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

### 6.2 响应

`code=0` 且 `subcode=0` 视为成功。源码注释标注：dolike 的实际成功信号可能是一对 `succ/fail` 令牌而非 `code`，此处按同级 CGI 外推，待实拍确认。

---

## 七、上传图片（写，特殊路由）

### 7.1 请求

- 方法：`POST`
- 完整 URL（**不经 h5 网关**，直连 `up.qzone.qq.com`）：

```
https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=<bkn>
```

- Form body（源码 [`uploadQzoneImage`](packages/protocol/src/web/qzone.ts:971)）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `filename` | `filename` | 固定占位 |
| `uin` | `<hostUin>` | 上传者 QQ |
| `skey` | `<skey>` | 直接带 skey 明文 |
| `zzpaneluin` | `<hostUin>` | |
| `p_uin` | `<hostUin>` | |
| `p_skey` | `<p_skey>` | 直接带 p_skey 明文 |
| `uploadtype` | `1` | |
| `albumtype` | `7` | |
| `exttype` | `0` | |
| `refer` | `shuoshuo` | 来源：说说 |
| `output_type` | `jsonhtml` | |
| `charset` | `utf-8` | |
| `output_charset` | `utf-8` | |
| `upload_hd` | `1` | 高清上传 |
| `hd_width` | `2048` | |
| `hd_height` | `10000` | |
| `hd_quality` | `96` | |
| `backUrls` | `http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image&url=https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=<bkn>` | 备用回退地址 |
| `base64` | `1` | 以 base64 传输 |
| `jsonhtml_callback` | `callback` | |
| `picfile` | `<base64图片>` | 图片 base64 负载 |
| `qzreferrer` | `https://user.qzone.qq.com/<hostUin>/main` | |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

### 7.2 响应结构（原始）

响应形如 `<script>frameElement.callback({...});</script>`，解析时先截到 `callback` 起再取 `{}`：

```
{
  "code": 0,
  "subcode": 0,
  "message": "",
  "data": {
    "albumid": "<相册id>",
    "lloc": "<定位串>",
    "url": "<图片直链>",
    "type": <类型>,
    "height": <高>,
    "width": <宽>
  }
}
```

### 7.3 输出

返回 `{ richval, url, albumid, lloc, type, width, height }`。其中 `richval` 按 `,<albumid>,<lloc>,<lloc>,<type>,<height>,<width>,,<height>,<width>` 构造（`sloc` 与 `lloc` 相同），供 publish 的 `richval` 使用；`url` 供 comment 的直链使用（两者用法不同，见下文）。

图片源支持 `file://`、`http(s)://`、`base64://`（含 data-URI 前缀），非 base64 源先经 `loadBinarySource` 加载转 base64 再上传（[`uploadQzoneImageFromSource`](packages/protocol/src/web/qzone.ts:926)）。

---

## 八、评论说说（写）

### 8.1 请求

- 方法：`POST`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=<bkn>
```

- Form body（源码 [`commentQzoneMsg`](packages/protocol/src/web/qzone.ts:1178)）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `qzreferrer` | `https://user.qzone.qq.com/<selfUin>` | 评论者（机器人）自己的空间 |
| `inCharset` | `utf-8` | |
| `outCharset` | `utf-8` | |
| `hostUin` | `<hostUin>` | 被评说说的主人 |
| `format` | `json` | |
| `ref` | `feeds` | |
| `topicId` | `<hostUin>_<tid>__1` | 定位被评 feed；`__1` 后缀 2/3 社区实现确认，第三个省略（未核实点） |
| `feedsType` | `100` | |
| `private` | `0` | |
| `paramstr` | `1` | |
| `richtype` | `1` 或 `''` | 带图评论时为 `1` |
| `richval` | 字符串 | **带图评论传图片直链 url（多图 `\t` 拼接），不是 publish 的 richval** |
| `isSignIn` | `''` | |
| `uin` | `<selfUin>` | 评论者 QQ |
| `content` | `<content>` | 评论内容 |
| `plat` | `qzone` | |
| `source` | `ic` | |
| `platformid` | `52` | |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

### 8.2 响应

`code=0` 且 `subcode=0` 即成功；返回的新评论 id 字段名不定（`commentid` / `commentId`），缺失时不视为失败，最佳努力返回 `{ comment_id }`。

---

## 九、拉黑 / 解除拉黑（写）

### 9.1 请求

- 方法：`POST`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/right/cgi_black_action_new?g_tk=<bkn>
```

- Form body（源码 [`setQzoneBlack`](packages/protocol/src/web/qzone.ts:1120)）：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `uin` | `<selfUin>` | 机器人自己 |
| `act_uin` | `<targetUin>` | 被操作对象 QQ |
| `action` | `1` / `2` | `1`=拉黑，`2`=解除拉黑 |
| `fupdate` | `1` | |
| `qzreferrer` | `https://user.qzone.qq.com/<selfUin>/main` | |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

### 9.2 响应

回调包裹的 body，可能含未加引号 key 的小片段 `{name:"Ack"}`，解析前先把 `{name:` 替换为 `{"name":`。成功信号：`subcode=0` 且 `code=0`。

---

## 十、修改说说查看权限（写，两步）

该 CGI 不是部分更新，而是整条说说重新提交（内容、richval、pic_bo 全量重发），因此分两步。

### 10.1 第一步：取说说详情

- 方法：`GET`
- 完整 URL（**注意代理域名是 `taotao.qq.com`，不是 `taotao.qzone.qq.com`**）：

```
https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?tid=<tid>&uin=<selfUin>&t1_source=1&not_trunc_con=1&need_right=1&not_adapt_outpic=1&g_tk=<bkn>
```

Query 参数（源码 [`getQzoneMsgDetail`](packages/protocol/src/web/qzone.ts:1379)）：`tid`、`uin`（机器人自己）、`t1_source=1`、`not_trunc_con=1`（不截断内容）、`need_right=1`、`not_adapt_outpic=1`、`g_tk`。

- 请求头：`Cookie: <cookie 罐>`

响应含重建所需全量字段：`tid`、`uin`、`content`、`conlist[]`、`pic[]`（含 `pic_id`、`pictype`、`height`/`b_height`、`width`/`b_width`、`smallurl`/`url1/2/3`）、`richtype`、`richval`、`pic_template`、`special_url`、`t1_subtype`/`subrichtype`、`feedversion`、`ver`、`ugc_right`、`to_sign`、`ugcright_id`、`code_version`。成功信号 `subcode ?? code` 为 `0`。

### 10.2 第二步：提交整条更新

- 方法：`POST`
- 完整 URL：

```
https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?g_tk=<bkn>
```

- Form body 由详情重建（`buildQzoneUpdatePayload`，[`qzone.ts`](packages/protocol/src/web/qzone.ts:1294)），再覆盖 `ugc_right`、按需追加 `allow_uins`：

| 字段 | 值/来源 |
| --- | --- |
| `syn_tweet_verson` | `1` |
| `tid` | 详情 `tid` |
| `paramstr` | `1` |
| `pic_template` | 详情 `pic_template` |
| `richtype` | 详情 `richtype`（图片贴无则取 1） |
| `richval` | 逐图从 `pic_id`（`,` 分隔，取第 2 段 albumid、第 3 段 lloc）重建为 `,albumid,lloc,lloc,type,height,width,,0,0`，多图 `\t` 拼接；无图时用详情 `richval` |
| `special_url` | 详情 `special_url` |
| `subrichtype` | `t1_subtype ?? subrichtype`，图片贴无则 `1` |
| `pic_bo` | 从各图 url 的 `bo=` query 参数提取（`decodeURIComponent`），拼接后 `<list>\t<list>` 双份 |
| `con` | 详情 `content`，若 `conlist` 存在则取其 `con` 拼接 |
| `feedversion` | 详情 `feedversion`（默认 1） |
| `ver` | 详情 `ver`（默认 1） |
| `ugc_right` | **覆盖为目标值**（`1/4/16/64/128`） |
| `to_sign` | 详情 `to_sign`（默认 0） |
| `ugcright_id` | 详情 `ugcright_id`（默认 `tid`） |
| `hostuin` | 详情 `uin`（默认 selfUin） |
| `code_version` | 详情 `code_version`（默认 1） |
| `format` | `fs` |
| `qzreferrer` | `https://user.qzone.qq.com/<hostuin>` |
| `allow_uins` | 可选，`16/128` 时必填 |

- 请求头：`Cookie: <cookie 罐>`、`Content-Type: application/x-www-form-urlencoded`

### 10.3 响应

`format=fs` 会把 JSON 包在回调里（`frameElement.callback({...});` 或 `_Callback({...});`），统一用 `parseQzoneJson` 首尾花括号切片处理。成功信号：`subcode=0` 且 `code=0`，返回 `{ ugc_right }`。

---

## 十一、未核实点汇总（源码注释明确标注）

以下为源码注释中明确写"待实拍确认 / 未真机核实 / 外推"的项，非实测结论：

| 项 | 说明 |
| --- | --- |
| `internal_unlike_app` 取消赞端点 | 惯例配对 CGI，无公开机器人实现验证，best-guess |
| delete 的成功/失败包结构 | `code`/`subcode` 字段由同级 CGI 外推，公开实现仅查 HTTP 2xx |
| comment 的 `topicId` 尾部 `__1` 后缀 | 2/3 社区实现确认，第三个省略 |
| comment 返回的新评论 id 字段名 | `commentid` / `commentId` 不定 |
| dolike 的成功信号 | 可能是 `succ/fail` 令牌而非 `code` |
| 动态（feeds）深分页游标 | `begintime`/`externparam`/`usertime` 透传未实现，待实拍 |

## 十二、风控与重试

- 说说列表：主路由（`taotao.qzone.qq.com`）遇 `code=-10000`「使用人数过多」自动经 `user.qzone.qq.com` → `taotao.qq.com` 路由重试一次（实拍该路由不受限）。
- 所有写操作（发/删/赞/评/改权）源码提示需调用方自行限流，Qzone 对高频主动行为风控，与发消息同级。

## 十三、参考社区实现

源码注释中对照过的公开实现：SmartHypercube/Qzone-API、cw1997/QzoneUtil、php-qzone/qzone.class.php、silica-github/qq_zone_delete、QLiker.py。
