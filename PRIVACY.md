# SnowLuma 隐私与数据处理说明 / Privacy & Data Handling Notice

- **生效日期 / Effective date:** 2026-06-19
- **版本 / Version:** 1.0
- **责任主体 / Provider:** SnowLumaDevs（联系方式 / Contact: motricseven@foxmail.com）

> 本说明以中文与英文两种语言提供。如有冲突，**以中文版本为准**。
> Provided in Chinese and English. **In case of conflict, the Chinese version prevails.**

---

## 中文版

### 1. 概述
SnowLuma 是一款**自托管**软件：它运行在**您自己的设备或服务器**上。**SnowLumaDevs（作者方）默认不收集、不接收、不存储您的任何个人数据**。本软件**不包含**任何需要联网激活、或向作者方回传信息的授权机制。
本说明唯一例外的数据外发情形，是第 4、5 条所述的两种，且其中遥测受严格限制（第 5 条）。

### 2. 本软件在您设备上存储的数据
为实现功能，本软件会在您的设备本地（如 SQLite 数据库、配置与日志文件）存储以下类别的数据。**这些数据保存在您本地、由您掌控，作者方无法访问：**
- **账号与登录凭据**：所登录的 QQ 账号信息、会话/令牌、WebUI 登录口令（以**加盐 scrypt 哈希**形式存储，不保存明文）。
- **关系数据**：好友、群组及成员的列表与资料。
- **消息数据**：为实现协议转换而处理或缓存的消息（视您的配置而定）。
- **运行配置与日志**：适配器配置、运行日志等。

> 说明：因 SnowLuma 是 QQ 协议工具，上述本地数据**必然**包含 QQ 账号及联系人信息。这与第 5 条"遥测绝不采集 QQ 账号/联系人"并不矛盾——本地存储 ≠ 对外传输。

### 3. 您作为数据控制者的责任
当您运行本软件处理您 QQ 联系人、群成员等他人的个人信息时，**您是该等个人信息的"数据控制者/处理者"**，须自行就该等处理承担合规责任（包括取得必要同意、保障安全、响应数据主体请求等）。作者方仅提供软件工具，不参与您的数据处理活动。

### 4. 数据离开您设备的唯一途径
除以下两种情形外，本软件不会将您的数据传输至任何外部目的地：
1. **您自行配置的通知 / Webhook**：当您主动配置通知渠道（如 Webhook）时，相应内容会按**您填写的地址与设置**外发。目的地与内容由您完全掌控，作者方不经手。
2. **匿名遥测**：见第 5 条。

### 5. 遥测（Telemetry）
**模式：默认开启（opt-out）。** 您可随时关闭（见 5.3）。

#### 5.1 采集内容（仅匿名、聚合，无法定位到个人）
- 应用版本、操作系统与 CPU 架构、Node.js 版本；
- 启动次数、功能使用计数（例如启用了哪些适配器/命令，**不含其参数或内容**）；
- 匿名化的崩溃栈与错误类型。

#### 5.2 绝不采集（显式负面清单）
本遥测**在任何情况下都不会**采集或传输：
- **QQ 账号 / UIN，及好友、群、成员的身份信息**；
- **消息内容或其元数据**、昵称、头像；
- 手机号、邮箱或任何联系方式；
- 凭据、令牌、密码；
- 用于身份画像的精确 IP 地址（若服务端在传输层偶然可见 IP，将即时丢弃、不入库、不进行关联）；
- 任何可直接或间接定位到自然人的标识。

#### 5.3 如何关闭与告知
- **首次运行提示**：软件首次运行时会在控制台与 WebUI 一次性告知遥测已默认开启及关闭方式。
- **一键关闭**：可通过环境变量 `SNOWLUMA_TELEMETRY=0`、配置项或 WebUI 开关随时关闭，关闭后即刻停止采集。

#### 5.4 用途、共享与保留
遥测数据**仅用于改进本软件**，**不向任何第三方出售或共享**，仅以匿名聚合形式保留必要期限。

#### 5.5 生效状态（重要）
本条款完整描述了 SnowLuma 的遥测机制，但**仅对实际包含遥测代码的发行版生效**。
> **当前生效状态（截至 2026-06-17）**：公开发行版**尚未包含**遥测代码，故本条款目前**处于未生效状态**。一旦某一发行版引入遥测，将在该版本的发布说明中明确告知，并使本条款对该版本生效。

### 6. 数据安全与保留
本地数据的安全与保留由您（运营者）控制。建议您妥善保护设备访问权限、定期更新 WebUI 口令。

### 7. 第三方组件
本软件可能捆绑第三方组件（如用于音视频处理的 FFmpeg）。此类组件**在您本地运行**、用于处理本地数据，**不向作者方或第三方外发**数据。

### 8. 未成年人
本软件面向开发者与技术用户，**不面向未成年人**，作者方不会有意收集未成年人信息。

### 9. 您的权利
由于作者方默认不持有您的任何个人数据，与您个人信息相关的访问、更正、删除等权利，应在**您本地的数据范围内**由您自行行使。如遥测启用且您有疑问，可通过第 10 条联系我们。

### 10. 联系方式
隐私相关问询：**motricseven@foxmail.com**。

### 11. 变更
本说明可不时更新，更新版本将注明生效日期。涉及遥测的重大变更将在发布说明中显著告知。

---

## English Version

### 1. Overview
SnowLuma is **self-hosted**: it runs on **your own device or server**. **By default, SnowLumaDevs (the authors) collect, receive, and store none of your data.** The Software contains **no** activation that requires network access or transmits information back to the authors. The only data that ever leaves your device is described in Sections 4 and 5, and telemetry is strictly limited (Section 5).

### 2. Data the Software Stores on Your Device
To function, the Software stores the following categories of data locally (e.g., in a SQLite database, configuration, and log files). **This data stays on your device under your control; the authors cannot access it:**
- **Account & credentials:** the signed-in QQ account, session/tokens, and the WebUI login password (stored as a **salted scrypt hash**, never in plaintext).
- **Relationship data:** lists and profiles of friends, groups, and members.
- **Message data:** messages processed or cached for protocol conversion (depending on your configuration).
- **Runtime configuration & logs.**

> Note: Because SnowLuma is a QQ protocol tool, this local data **necessarily** includes QQ account and contact information. This does not conflict with Section 5 ("telemetry never collects QQ account/contacts") — local storage ≠ outbound transmission.

### 3. You Are the Data Controller
When you run the Software to process the personal information of your QQ contacts, group members, or other individuals, **you are the data controller/processor** for that information and are responsible for compliance (obtaining any necessary consent, securing the data, responding to data-subject requests). The authors merely provide a software tool and take no part in your processing.

### 4. The Only Ways Data Leaves Your Device
The Software transmits your data to an external destination only in these two cases:
1. **Notifications / webhooks you configure:** when you set up a notification channel (e.g., a webhook), the relevant content is sent to **the address and settings you provide**. You fully control the destination and content; the authors are not involved.
2. **Anonymous telemetry:** see Section 5.

### 5. Telemetry
**Mode: ON by default (opt-out).** You can disable it at any time (see 5.3).

#### 5.1 What is collected (anonymous, aggregate, non-identifying only)
- Application version, OS and CPU architecture, Node.js version;
- Launch counts and feature-usage counts (e.g., which adapters/commands are enabled — **never their arguments or content**);
- Anonymized crash stacks and error types.

#### 5.2 Never collected (explicit negative list)
Telemetry will **never, under any circumstances**, collect or transmit:
- **QQ account / UIN, or the identity of any friend, group, or member**;
- **Message content or metadata**, nicknames, avatars;
- Phone numbers, emails, or any contact details;
- Credentials, tokens, passwords;
- Precise IP addresses used for profiling (any IP incidentally visible at the transport layer is discarded immediately, not stored, not correlated);
- Any identifier that could directly or indirectly identify a natural person.

#### 5.3 How to disable; notice
- **First-run notice:** on first run the Software gives a one-time notice in the console and WebUI that telemetry is on by default and how to disable it.
- **One switch off:** disable any time via the `SNOWLUMA_TELEMETRY=0` environment variable, a config option, or the WebUI toggle; collection stops immediately.

#### 5.4 Use, sharing, retention
Telemetry is used **only to improve the Software**, is **never sold or shared with any third party**, and is retained only in anonymous aggregate form for as long as necessary.

#### 5.5 Effective status (important)
This Section fully describes SnowLuma's telemetry mechanism but is **effective only for builds that actually contain telemetry code.**
> **Current status (as of 2026-06-17):** public releases **do not yet contain** telemetry code, so this Section is currently **not in effect**. If a release introduces telemetry, its release notes will say so and this Section will take effect for that release.

### 6. Security & Retention
Security and retention of local data are under your (the operator's) control. Protect device access and rotate the WebUI password regularly.

### 7. Third-Party Components
The Software may bundle third-party components (such as FFmpeg for media processing). These run **locally** on your device to process local data and **send nothing** to the authors or third parties.

### 8. Minors
The Software targets developers and technical users, is **not directed to minors**, and the authors do not knowingly collect minors' information.

### 9. Your Rights
Because the authors hold none of your personal data by default, rights of access, correction, and deletion are exercised by you **over the data on your own device**. If telemetry is enabled and you have questions, contact us (Section 10).

### 10. Contact
Privacy inquiries: **motricseven@foxmail.com**.

### 11. Changes
This Notice may be updated from time to time; updated versions bear an effective date. Material changes affecting telemetry will be prominently noted in release notes.
