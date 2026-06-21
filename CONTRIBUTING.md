# 贡献指南

欢迎！如果你正在阅读这份文档，多半是因为你想给 SnowLuma 提一个 PR、修一个 bug，或者只是想了解这个项目是怎么运作的。无论你是第一次接触开源、还是已经有十年经验，我们都希望让你尽快上手。

参与项目即视为你同意遵守 [行为准则（Code of Conduct）](./CODE_OF_CONDUCT.md)。在开始之前请花两分钟读一下，它定义了我们希望社区维持的氛围。

---

## 在动手之前

SnowLuma 处于开发早期，迭代速度很快，**接口与目录结构随时可能变化**。如果你打算做较大的改动，强烈建议先在 issue 或者社群里和维护者对齐一下方向，避免做了一半发现已经被另一条路替代。

不知道从哪里入手？以下几类贡献最容易被合并：

- 修复你在使用中遇到的具体 bug，附最小复现步骤。
- 改善错误提示、文档、注释、类型签名。
- 给已有模块补测试，尤其是 `packages/core` 下覆盖率较低的部分。
- 实现 [RoadMap.md](./RoadMap.md) 中列出的、还没被认领的项。

如果你只是想看看代码长什么样，可以直接跳到 [本地开发环境](#本地开发环境)。

---

## 项目结构速览

这是一个 pnpm workspace monorepo，主要 package 如下：

| 路径 | 作用 |
| --- | --- |
| `packages/core` | 核心运行时：协议、桥接、OneBot 适配、WebUI 服务端 |
| `packages/sdk` | 面向第三方开发者的 SDK，会发布到 npm |
| `packages/runtime` | 运行时辅助包 |
| `packages/websocket` | WebSocket 实现 |
| `packages/webui` | 基于 Vite + React 的前端控制台 |
| `tools/` | 版本管理、发布脚本 |
| `.github/workflows/` | CI / 发布 / 自动合并工作流 |

入口在 `packages/core/src/index.ts`，整体架构在 `packages/core/src/bridge/` 下能看出大致脉络。

---

## 本地开发环境

### 系统要求

- **Node.js ≥ 22**（`engines` 字段强制，低版本会报错）
- **pnpm 10.28.0+**（项目通过 `packageManager` 字段锁定，建议用 `corepack enable` 安装匹配版本）
- macOS / Linux / Windows 均可。如果要构建原生产物，需要对应平台的工具链。

### 拉代码、装依赖、跑起来

```bash
# 1. Fork 仓库后克隆你自己的 fork
git clone https://github.com/<你的用户名>/SnowLuma.git
cd SnowLuma

# 2. 切到 dev 分支（所有开发都基于 dev，不是 main）
git checkout dev

# 3. 安装依赖
pnpm install

# 4. 跑类型检查，确认环境 OK
pnpm typecheck

# 5. 跑测试
pnpm test

# 6. 启动开发模式
pnpm dev          # core
pnpm dev:web      # webui
```

如果 `pnpm install` 卡住或报错，先确认 Node 版本和 pnpm 版本，再看 `.npmrc` 里是否配置了你环境下可用的 registry。

---

## 第一次提交 PR

### 1. 创建分支

请基于 `dev` 创建分支，不是 `main`。`main` 是受保护的稳定分支，PR 也不要直接提到 `main`。

```bash
git checkout dev
git pull upstream dev          # 假设你把官方仓库设为 upstream remote
git checkout -b fix/onebot-mention-encoding
```

分支命名没有强制规则，但建议用 `fix/...`、`feat/...`、`docs/...`、`refactor/...` 这种前缀，便于一眼看出意图。

### 2. 写代码

- **保持改动聚焦**：一个 PR 只做一件事。顺手发现的其他问题请单独开 issue 或新 PR。
- **跟随既有风格**：不要为了你个人偏好引入大规模格式化或重命名。
- **写测试**：修 bug 时优先写一个能复现该 bug 的测试，确认它会 fail，再让它 pass。新增功能至少补上 happy path 的测试。
- **不要添加无意义的注释**：标识符已经说清楚的事情不需要再写一遍。注释应当解释"为什么"，而不是"做了什么"。

提交之前请本地跑一遍：

```bash
pnpm typecheck
pnpm test
```

CI 上跑的是同一套检查，本地通过几乎能保证 CI 通过。

### 3. 提交信息

我们大致遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```
<type>(<scope>): <subject>

<body>
```

`type` 常用：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。
`scope` 常用：`core` / `sdk` / `webui` / `onebot` / `bridge` / `protocol` 等模块名。

示例：

```
fix(onebot): handle empty mention segments in group messages
refactor(bridge): extract BridgeInterface as the OneBot-facing seam
docs: clarify dev environment setup steps
```

> ⚠️ **请不要**在你的提交信息里使用 `[merge]` 前缀或 `chore(release):` 前缀 —— 这两个前缀是维护者用来触发自动合并到 `main` 的，会让你的 PR 行为异常。详见后文 [维护者参考](#维护者参考release--自动合并流程)。

### 4. 推送并发起 PR

```bash
git push origin fix/onebot-mention-encoding
```

到 GitHub 上发起 PR，**目标分支选 `dev`**。请在 PR 描述里写明：

- 这个 PR 解决什么问题 / 实现什么功能。
- 主要的实现思路（如果有非显然的取舍）。
- 测试方式（你跑了什么、怎么验证有效）。
- 关联的 issue（如有）。

### 5. Code Review 与合并

- 维护者会在能腾出时间时来 review。如果一周内没有任何回应，欢迎在 PR 里 @ 一下，或者去社群里提醒。
- review 意见请尽量在同一个 PR 内修改，避免反复关闭重开。
- 合并方式由维护者决定，通常是 squash merge 到 `dev`。**`main` 由维护者通过自动化工作流统一从 `dev` 合入**，你不需要操心 `main`。

---

## 风格与约定

### 代码风格

- TypeScript 严格模式，按 `tsconfig.base.json` 配置。
- 优先用现有抽象，不要为"假想的未来需求"提前抽象。
- 不要给内部函数加防御性的参数校验，除非是系统边界（用户输入、外部 API）。
- 不要保留死代码、被注释掉的代码或者 `// TODO` 没有具体上下文的占位。

### 测试

- 单测放在被测代码同包的 `tests/` 或同目录的 `*.test.ts`，按既有风格走。
- 测试要描述行为，不要测实现细节。`it('should call internal foo')` 这种是反例。
- 涉及 IO / 时序 / 外部进程的，用现有的 fake/stub 模式，参考 `packages/core/src/onebot/` 下的 `fake-bridge` 类测试。

### 文档

- 用户/贡献者可见的行为变化，需要相应更新 README 或对应 package 下的文档。
- SDK 的破坏性变更必须更新 `packages/sdk/CHANGELOG.md` 和 `packages/sdk/VERSIONING.md`。

---

## 报告 Bug / 请求功能

- **Bug 报告**：开 issue，附最小复现步骤、期望行为、实际行为、版本号、运行环境。能附上日志最好。
- **功能请求**：先描述你想解决的实际场景，再描述你想要的接口。维护者更在意"为什么需要"而不是"具体怎么做"。
- **安全问题**：请勿公开发 issue，先通过社群私聊联系维护者。

社群入口（见 [README](./README.md)）：

- QQ：[SnowLuma-QQ](https://qm.qq.com/q/g3UMLpWALe)
- Telegram：[SnowLuma-TG](https://t.me/napcatqq)

---

## 维护者参考：release & 自动合并流程

> 以下内容主要写给具备 `main` 推送 / 发版权限的维护者。普通贡献者只需要把 PR 提到 `dev`，不需要关心这一节。

### 分支模型

SnowLuma 使用 **`main` + `dev`** 双分支模型：

- **`main`** — 受保护的稳定分支，仅接收来自 `dev` 的合并 PR。**禁止直接 push**。
- **`dev`** — 日常开发分支。所有功能、修复、文档变更都先合入 `dev`。
- **`native/auto-update-*`** — 由 `SnowLuma Bot` 自动创建的原生产物更新分支（来自 `SnowLumaNative`，不需要手动维护）。

### 把 `dev` 合并到 `main`

工作流 `.github/workflows/promote-dev-to-main.yml` 会以 `SnowLuma Bot` 身份开 / 更新一个 `dev → main` 的 PR，并可选地自动合并。无论用哪种触发方式，工作流都会调用 `gh pr merge --auto`：**只有 `main` 分支保护中所有 required status checks（typecheck + 各架构 build）都通过后，机器人才会真正合并**。失败的工作流会卡住合并。

#### 1. 提交信息前缀（推荐日常使用）

向 `dev` push 一个提交，提交信息**以**以下任一前缀**开头**即触发（不区分大小写）：

- `[merge]` — 例如 `[merge] fix: hotfix for OneBot mention`
- `chore(release):` — 例如 `chore(release): v1.7.0`，符合 conventional commits 的发版习惯

> 是**前缀**匹配，不是任意位置。`fix: something [merge]` 不会触发，必须把 `[merge]` 写在最前面。

#### 2. 推送 `chore.*` Tag

任何符合 `chore.*` 的 tag（如 `chore.merge-20240509`、`chore.promote-v1.7.0`）被推送时也会触发：

- `chore.*` → 仅触发 `promote-dev-to-main.yml`（开 PR，自动合并）
- `v*` → 仅触发 `release.yml`（构建发布产物）

推荐流程：先用 `chore.*` tag 把 `dev` 合入 `main`，待合并完成后再在 `main` 上打 `v*` tag 触发发布。这样 `release.yml` 始终基于已过完所有检查的 `main` HEAD 构建。

#### 3. 手动触发

打开仓库 Actions 页面 → `Promote Dev to Main` → `Run workflow`。可选输入：

- `auto_merge`：是否启用 auto-merge（默认 `true`）。
- `merge_method`：`merge` / `squash` / `rebase`（默认 `merge`）。

### 启用 `main` 分支保护（必做）

仓库管理员需要在 GitHub 上为 `main` 配置规则集（Repository Rules）或经典分支保护，至少满足：

1. **Settings → Rules → Rulesets**（推荐）或 **Settings → Branches → Branch protection rules**。
2. 选择 `main` 作为目标分支。
3. 勾选：
   - **Restrict deletions** — 禁止删除 `main`。
   - **Require a pull request before merging** — 所有合并必须走 PR。
   - **Block force pushes** — 禁止强推。
   - **Require status checks to pass before merging（必勾）** — 把以下来自 `dev-build.yml` 的 check 全部加为 required：
     - `typecheck`
     - `build (win-x64)`
     - `build (linux-x64)`
     - `build (linux-arm64)`
   - **Require branches to be up to date before merging** — 保证 PR 合并前已 rebase 过最新 `main`。
4. 在 **Bypass list / Allow specified actors to bypass** 中加入 `SnowLuma Bot` GitHub App。这样 `gh pr merge --auto` 才能在所有 required check 通过后由机器人自动完成合并；否则 PR 会一直卡在 auto-merge 等待人工 review。
5. **不要**把任何用户加入 push 白名单，确保「禁止向 `main` 直接提交」的约束生效。第一次设置完后，连仓库管理员也只能通过 PR 改 `main`。

效果：任何对 `dev` 的推送都会先在 `dev-build.yml` 上跑 typecheck + 三个架构的 build；只有全部成功，promote 工作流的 `--auto` 合并才会真正发生。失败时 PR 会保留在 open 状态，修复后再次推到 `dev` 即可重新触发检查。

### 必需的 Secrets

`promote-dev-to-main.yml` 复用 `SnowLumaNative/build-native.yml` 同一个 GitHub App。请确认 SnowLuma 仓库（或 organization）级别已经配置：

- `SNOWLUMA_BOT_APP_ID` — 数字类型的 App ID。
- `SNOWLUMA_BOT_PRIVATE_KEY` — 该 App 的 PEM 私钥。

App 必须在本仓库已安装，且授予 **Contents: Read+Write**、**Pull requests: Read+Write**。

### 本地工作流速查（维护者）

```bash
# 把 dev 合入 main（三选一）

# 方式 A：commit-msg 前缀
git commit -m "chore(release): v1.7.0"     # 或 "[merge] fix: hotfix"
git push                                    # → 触发 promote-dev-to-main

# 方式 B：chore.* 合并 tag（与发布 tag 解耦）
git tag chore.merge-20240509                # 或 chore.promote-v1.7.0 等
git push origin chore.merge-20240509        # → 触发 promote-dev-to-main

# 方式 C：在 Actions 页面手动 Run workflow

# 合并完成后，发布版本（在 main 上打 v* tag）
git checkout main && git pull
git tag v1.7.0
git push origin v1.7.0                      # → 仅触发 release.yml
```

---

## 还有问题？

- 看一下已有的 issue 和 PR，可能你的问题已经被讨论过。
- 去社群问一句（QQ / TG 链接见上方）。
- 如果只是想确认"我这么改 OK 吗"，欢迎开 draft PR，先把代码亮出来再讨论。

感谢你愿意花时间贡献 SnowLuma —— 这个项目能走多远，取决于你们每一个人。❄️

## 贡献的许可 / Licensing of contributions

当你提交 PR，即表示你的贡献按本项目的 [`LICENSE`](LICENSE)（SnowLuma 源码可见非商业许可）授权，且你声明你有权这么做、贡献为你的原创（若含第三方材料，请在 PR 中显著标注其来源与许可证）。

**你保留对自己贡献的版权**，同时**授予 SnowLumaDevs 一项永久、全球、免费、不可撤销、可再许可（sublicensable）的许可**，可使用、复制、修改、分发你的贡献并基于其制作衍生作品，**包括以本项目非商业许可之外的其他条款（含商业条款）再许可与分发**——以便项目方无需逐一回头征求同意，即可在获授权的商业场景中使用社区贡献。

By opening a PR, you agree your contribution is licensed under the project's [`LICENSE`](LICENSE); you represent that you have the right to submit it and that it is your own work (clearly identify any third-party material in the PR).

**You retain copyright in your contribution** and additionally grant SnowLumaDevs a **perpetual, worldwide, royalty-free, irrevocable, sublicensable license** to use, reproduce, modify, distribute, and create derivative works of your contribution, **including the right to relicense and distribute it under terms other than this project's non-commercial license (including commercial terms)** — so the project can use community contributions in authorized commercial scenarios without seeking each contributor's consent again.
