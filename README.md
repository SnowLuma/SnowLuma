<h1 align="center">
  <img src=".github/logo.svg" width="100%" alt="SnowLuma" />
</h1>

<p align="center">
  <i>Next Remote Protocol Framework.</i>
</p>

<p align="center">
  <a href="https://github.com/SnowLuma/SnowLuma/releases"><img alt="Release" src="https://img.shields.io/github/v/release/SnowLuma/SnowLuma?label=release&style=flat-square"></a>
  <a href="https://github.com/SnowLuma/SnowLuma/actions"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/SnowLuma/SnowLuma/release.yml?branch=main&style=flat-square&label=build"></a>
  <a href="https://www.npmjs.com/package/@snowluma/sdk"><img alt="NPM" src="https://img.shields.io/npm/v/%40snowluma%2Fsdk?style=flat-square&label=sdk&color=cb3837"></a>
  <a href="https://github.com/SnowLuma/SnowLuma/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/SnowLuma/SnowLuma?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://github.com/SnowLuma/SnowLuma/releases">Releases</a> ·
  <a href="https://github.com/SnowLuma/SnowLuma/issues">Issues</a> ·
  <a href="https://qm.qq.com/q/g3UMLpWALe">QQ 群</a> ·
  <a href="https://t.me/napcatqq">Telegram</a>
</p>

---

SnowLuma 是一个基于 TypeScript 的协议转换框架，旨在为 QQ 客户端提供 [OneBot v11](https://github.com/botuniverse/onebot-11) 标准接口，支持 WebSocket/HTTP 适配、多账号并行及 WebUI 管理。

> ⚠️ **免责声明**：SnowLuma 是独立的第三方互操作项目，**与腾讯 / QQ 无任何隶属或授权关系**。本项目**仅供学习与技术研究**，请遵守《QQ 用户协议》及适用法律；软件按"现状"提供、不附带任何担保，使用风险自负。详见 [`EULA.md`](EULA.md)。
>
> ⚠️ **Disclaimer**: SnowLuma is an independent, third-party interoperability project with **no affiliation with or endorsement by Tencent / QQ**, provided **for study and research only**, "as is" without warranty. Comply with the QQ User Agreement and applicable law; use at your own risk. See [`EULA.md`](EULA.md).

## 特性

- **OneBot v11 兼容**：支持文本、音视频、Markdown、JSON 等消息格式。
- **高性能架构**：TypeScript 全栈，基于 pnpm monorepo 管理，核心逻辑分离。
- **现代化管理**：内置 WebUI 面板，支持实时日志、密码热更、多账号管理。
- **多适配器支持**：WebSocket (Server/Client)、HTTP (Server/Post)。
- **数据持久化**：使用 SQLite 存储好友、群组等关系数据。

## 快速开始

1. 从 [Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载最新发布包并解压。
2. 运行 `./launcher.bat` (Windows) 或 `./launcher.sh` (Linux)。
3. 访问 `http://localhost:5099` (初始账号 `admin`，密码见控制台输出)。

## 许可 / License

SnowLuma 采用 **源码可见非商业许可（SnowLuma Source-Available Non-Commercial License）**，见 [`LICENSE`](LICENSE)。**这不是 OSI 开源许可**：源码公开供查看、学习与非商业自托管，但**禁止任何商业使用**（出售、转售、付费托管 / 代搭 / 代运营等），公开发布修改版须事先书面授权。随附的原生附加组件（`snowluma-*.node` 等）为专有组件，不在本许可范围内。二进制发行包另受 [`EULA.md`](EULA.md) 约束；商业授权请联系 motricseven@foxmail.com。参与贡献请阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

SnowLuma is under a **source-available, non-commercial** license (see [`LICENSE`](LICENSE)) — **NOT** an OSI open-source license. The source is published for study and non-commercial self-hosting; **commercial use is prohibited** without prior written permission, and the bundled native addon (`snowluma-*.node`) is proprietary and not covered by this license.

## 鸣谢

参考了 [LagrangeV2](https://github.com/LagrangeDev/LagrangeV2) 的协议定义与 [NapCatQQ](https://github.com/NapNeko/NapCatQQ) 的实现思路。

---

<p align="center">
<a href="https://github.com/SnowLuma/SnowLuma/graphs/contributors"><img src="https://contrib.rocks/image?repo=SnowLuma/SnowLuma" /></a>
</p>

