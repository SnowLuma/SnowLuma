# SnowLuma 维护手册

本机环境速记，供日常更新容器、本地构建测试、向上游提交 PR 时直接参照。所有路径基于本机仓库根目录 `e:/SnowLuma`。

## 环境约定（重要前提）

| 项目 | 值 |
| --- | --- |
| 仓库根目录 | `e:/SnowLuma` |
| Git remote `origin` | 个人 fork：`https://github.com/tt-P607/SnowLuma.git` |
| Git remote `upstream` | 官方：`https://github.com/SnowLuma/SnowLuma.git` |
| 开发分支 | `dev`（一切基于 dev，**不要碰 main**） |
| 本地分支 `dev` 跟踪 | `origin/dev`（自己的 fork） |
| 官方镜像 | `motricseven7/snowluma:latest` |
| 本地构建镜像 tag | `snowluma:local` |
| Dockerfile 所在目录 | `e:/SnowLuma.Docker.Framework`（仓库的**同级目录**，不在本仓库内） |
| compose 文件 | [`docker/docker-compose.yml`](docker/docker-compose.yml) |
| Node / pnpm | Node ≥ 22，pnpm 10.28.0+ |

数据持久化目录（挂载在宿主机，重建容器不丢登录态/聊天记录）：
`docker/data`、`docker/.config`、`docker/.local`、`docker/qq-acct2`。这些目录通过 `.git/info/exclude` 在本地忽略，不进 git。

---

## 一、官方镜像更新（日常更新，最常用）

官方发新版本（例如 tag `v1.9.5`）后，确认 [`docker/docker-compose.yml`](docker/docker-compose.yml) 中 `snowluma` 服务的 `image` 是 `motricseven7/snowluma:latest`，然后在仓库根目录执行：

```powershell
# 1. 拉取最新官方镜像
docker compose -f docker/docker-compose.yml pull snowluma

# 2. 重新创建并启动（仅 snowluma 服务）
docker compose -f docker/docker-compose.yml up -d snowluma
```

> `up -d` 会在镜像有更新时自动重建容器；数据已挂载到宿主机，登录态不会丢失。

验证：

```powershell
# 容器状态
docker ps --filter name=snowluma

# 确认容器内运行的版本号
docker exec snowluma cat /app/snowluma/package.json

# 跟踪运行日志
docker compose -f docker/docker-compose.yml logs -f snowluma
```

WebUI 控制台：浏览器访问 `http://localhost:5099`。

### 关于免扫码（请勿改动）

[`docker/docker-compose.yml`](docker/docker-compose.yml) 里以下两项共同固定 NTQQ 容器的硬件设备指纹，避免每次重建容器都要重新扫码登录，**不要删除或修改**：

- `hostname: snowluma-stable`
- `mac_address: 02:42:ac:11:00:99`

同时，持久化的机器码文件保存在宿主机的 `./data/config/machine-id`，容器启动时会自动读取并创建到 `/etc/machine-id` 的软链接。

### 多个 QQ 账号（第二个和第三个）

采用 SnowLuma 官方原生多账号支持：在 [`docker/docker-compose.yml`](docker/docker-compose.yml) 的 `snowluma` 服务里通过环境变量 `SNOWLUMA_EXTRA_QQ_HOMES=/app/qq-acct2,/app/qq-acct3` 指定额外的 QQ 数据目录，并把对应的宿主机目录挂进去（`./qq-acct2:/app/qq-acct2`、`./qq-acct3:/app/qq-acct3`）。容器内 SnowLuma 进程会在主账号登录后自动拉起这些额外账号。若某账号未登录，访问 noVNC 桌面扫码即可：VNC 端口 `5900`，noVNC 网页端口 `6081`。

---

## 二、本地构建镜像（测试未合并的改动）

当本地改了 `packages/` 下的源码、还没合并进官方镜像，需要在容器里实测时，用本地构建的 `snowluma:local` 镜像。

> 原理：官方镜像 = 基础环境（QQ + noVNC + 系统依赖）+ `SnowLuma.Framework.tar.gz`（打包后的运行产物）。本地构建只替换运行产物这一层，基础环境复用官方镜像 `motricseven7/snowluma:latest`，对应同级目录 [`../SnowLuma.Docker.Framework/Dockerfile.local`](../SnowLuma.Docker.Framework/Dockerfile.local)。
>
> ⚠️ **不要直接用 [`../SnowLuma.Docker.Framework/Dockerfile`](../SnowLuma.Docker.Framework/Dockerfile) 全量构建**：它会从 `dldir1v6.qq.com` 下载 `linuxqq_*.deb`，而该地址已加防盗链，直接请求返回 404（`Resource not found`）。只有 `Dockerfile.local` 的 `FROM motricseven7/snowluma:latest` + `COPY tarball` 方式可用。

### 步骤 1：构建 Linux 运行产物（含 WebUI）

容器是 Linux/x64，必须指定目标平台交叉打包，并开启 WebUI：

```powershell
cd e:/SnowLuma/packages/core
pnpm exec cross-env SNOWLUMA_TARGET=linux-x64 BUILD_WEBUI=true vite build
```

产物输出到 `e:/SnowLuma/dist/`，包含 `index.mjs`、若干 chunk、`native/`（linux-x64 原生模块）。

> 关键点：
> - `SNOWLUMA_TARGET=linux-x64` —— 否则会打包 Windows 的 `.dll/.node`，容器里加载失败。
> - `BUILD_WEBUI=true` —— 否则 `__BUILD_WEBUI__` 为 false，WebUI（5099）整段不会启动。

### 步骤 2：补齐 WebUI 静态资源 `client/`

`vite build` 不产出 WebUI 前端静态文件，从官方镜像里原样拷一份 `client/` 到 `dist/`：

```powershell
docker run --rm -v e:/SnowLuma/dist:/out motricseven7/snowluma:latest cp -a /app/snowluma/client /out/client
```

> 注意用 `cp -a`（保留属性），不要用 `cp -r`（旧版 busybox 不识别 `-c`/部分参数会报错）。

### 步骤 3：打包成 Framework tarball

Dockerfile 通过 `COPY SnowLuma.Framework.tar.gz` 引入产物。把 `dist/` 整个打包覆盖到同级目录：

```powershell
cd e:/SnowLuma/dist
tar -czf ../../SnowLuma.Docker.Framework/SnowLuma.Framework.tar.gz .
```

> 必须 `cd dist` 后用 `tar ... .` 打包**目录内容**，不要在仓库根目录打包整个 dist（会把路径前缀和 docker 数据目录带进去，导致 `tar: Cannot stat` 报错）。

### 步骤 4：构建本地镜像

在仓库根目录执行（构建上下文是同级的 Framework 目录，**必须用 `-f` 指定 `Dockerfile.local`**，否则默认 `Dockerfile` 全量构建会因 QQ 防盗链 404 失败）：

```powershell
docker build -t snowluma:local -f ../SnowLuma.Docker.Framework/Dockerfile.local ../SnowLuma.Docker.Framework/
```

### 步骤 5：切换 compose 到本地镜像并启动

把 [`docker/docker-compose.yml`](docker/docker-compose.yml) 中 `snowluma` 服务的镜像改为本地镜像：

```yaml
  snowluma:
    image: snowluma:local      # 测试时用本地；回归官方时改回 motricseven7/snowluma:latest
```

然后重建：

```powershell
cd e:/SnowLuma/docker
docker compose up -d snowluma
```

### 测试完成后回归官方镜像

PR 被官方合并、新官方镜像发布后，把 `image` 改回 `motricseven7/snowluma:latest`，再走 [一、官方镜像更新](#一官方镜像更新日常更新最常用) 的 pull + up 流程即可。

---

## 三、向上游提交 PR

遵循 [`CONTRIBUTING.md`](CONTRIBUTING.md)：所有 PR 基于 `dev`，**目标分支必须是 `dev`，不是 `main`**。

### 步骤 1：先同步上游 dev

```powershell
cd e:/SnowLuma
git fetch upstream
git merge upstream/dev          # 或 git rebase upstream/dev
```

### 步骤 2：改代码 + 写测试

- 一个 PR 只做一件事，保持改动聚焦。
- 修 bug：先写一个能复现的测试（确认会 fail），再让它 pass。
- 新功能：至少补 happy-path 测试。
- 不写无意义注释，注释只解释"为什么"。

### 步骤 3：本地验证（与 CI 同一套检查）

```powershell
# 全量
pnpm typecheck
pnpm test

# 或只跑改动相关的单包测试（更快），例如 onebot：
cd e:/SnowLuma/packages/onebot
pnpm exec vitest run tests/message-parser.test.ts
```

### 步骤 4：提交（Conventional Commits）

格式 `<type>(<scope>): <subject>`，常用 type：`feat`/`fix`/`docs`/`refactor`/`test`/`chore`/`perf`；常用 scope：`core`/`onebot`/`bridge`/`protocol`/`sdk`/`webui`。

```powershell
git add <改动的文件>
git commit -m "fix(onebot): support inline file url/path in send_group/private_msg"
```

> ⚠️ 提交信息**禁止**以 `[merge]` 或 `chore(release):` 开头 —— 这两个前缀是维护者触发自动合并到 `main` 的开关，普通 PR 用了会行为异常。

### 步骤 5：推送到 fork 并开 PR

```powershell
git push origin dev
```

用 GitHub CLI 开 PR（已登录 gh）：

```powershell
gh pr create --repo SnowLuma/SnowLuma --base dev --head tt-P607:dev `
  --title "fix(onebot): support inline file url/path in send_group/private_msg" `
  --body-file .local/pr-body.md
```

> PR 正文较长时写到 `.local/pr-body.md` 再用 `--body-file` 引入，避免 PowerShell 引号转义问题。`.local/` 已被忽略，不进 git。

### 步骤 6：根据 review 修改

维护者提了修改意见后，在**同一分支**继续改 + commit + `git push origin dev`，PR 会自动更新。若要清理本地多余提交，用 `git rebase --onto`，再 `git push origin dev --force-with-lease`。

---

## 四、本地忽略文件的正确做法

**项目通用**的忽略规则才写进 [`.gitignore`](.gitignore)（需提 PR）。**仅本机**的忽略（如 docker 数据目录、个人笔记），写进本地私有的 `.git/info/exclude`，不要污染 `.gitignore`：

```
# .git/info/exclude
docker/
SnowLuma.Framework.tar.gz
接口README.md
snowluma_adapter_prompt.md
```

> 维护者明确要求：非项目通用的 gitignore 条目必须放 `.git/info/exclude`。

---

## 五、常见问题排查

| 现象 | 原因 / 排查 |
| --- | --- |
| 重启后要重新扫码 | 检查 `hostname`/`mac_address`/`machine-id` 三项是否都在，缺一就会换设备指纹 |
| 本地镜像 WebUI（5099）打不开 | 构建时漏了 `BUILD_WEBUI=true`，或漏了步骤 2 拷 `client/` |
| 容器启动报 `Cannot find module .../config-xxx.js` | `dist` 打包不完整，确认步骤 3 在 `dist` 目录内 `tar ... .` 打包了全部 chunk |
| 容器里加载 native 报错 | 构建时漏了 `SNOWLUMA_TARGET=linux-x64`，打成了 Windows 产物 |
| TTS/插件发文件报路径找不到 | 文件路径需在容器内可见，确认 `docker-compose.yml` 里挂载了对应宿主机目录 |
| `docker compose` 报「找不到指定路径」 | 在 `e:/SnowLuma/docker` 目录内直接跑 `docker compose ...`，或在根目录用 `-f docker/docker-compose.yml` |

---

## 命令速查

```powershell
# —— 官方更新 ——
docker compose -f docker/docker-compose.yml pull snowluma
docker compose -f docker/docker-compose.yml up -d snowluma

# —— 本地构建测试 ——
cd e:/SnowLuma/packages/core
pnpm exec cross-env SNOWLUMA_TARGET=linux-x64 BUILD_WEBUI=true vite build
docker run --rm -v e:/SnowLuma/dist:/out motricseven7/snowluma:latest cp -a /app/snowluma/client /out/client
cd e:/SnowLuma/dist; tar -czf ../../SnowLuma.Docker.Framework/SnowLuma.Framework.tar.gz .
cd e:/SnowLuma; docker build -t snowluma:local ../SnowLuma.Docker.Framework/
cd e:/SnowLuma/docker; docker compose up -d snowluma   # image 需先改为 snowluma:local

# —— PR ——
git fetch upstream; git merge upstream/dev
pnpm typecheck; pnpm test
git add .; git commit -m "fix(scope): subject"
git push origin dev
gh pr create --repo SnowLuma/SnowLuma --base dev --head tt-P607:dev --title "..." --body-file .local/pr-body.md
```
