# Third-party notices

SnowLuma 的发行包包含以下第三方组件。第三方组件继续适用其各自的许可，
不受 SnowLuma 源码许可中与其许可冲突的条款约束。

## Lagrange.Core

- 项目：<https://github.com/LagrangeDev/Lagrange.Core>
- 固定版本：`9efbb19bc5d168de538c586023529729b920681f`
- 许可：GNU General Public License v3.0（GPL-3.0）
- 用途：构建无需桌面 QQ 客户端的独立协议宿主

发行包在 `native/Lagrange.Core.LICENSE` 中附带完整许可文本。对应源码由上游固定
提交、[`packages/lagrange-host`](packages/lagrange-host) 中的宿主源码与补丁，以及
[`tools/build-lagrange-host.mjs`](tools/build-lagrange-host.mjs) 中可复现的构建步骤组成。

Lagrange.Core 与 SnowLuma 均不隶属于腾讯或 QQ，也未获得其认可或授权。
