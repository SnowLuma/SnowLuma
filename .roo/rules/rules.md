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

> **v1.14.1+ 容器布局（重要，勿用旧路径）**：运行产物在 `/app/runtime`（镜像 ENV `SNOWLUMA_HOME=/app/runtime`），数据/工作目录在 `/app/data`（supervisord `directory=/app/data`，进程 `node /app/runtime/index.mjs`）。旧版 `/app/snowluma` + `/app/snowluma-data` 已废弃。

数据持久化目录（挂载在宿主机，重建容器不丢登录态/聊天记录）：
`docker/data`（→ `/app/data`）、`docker/.config`（→ `/app/.config`）、`docker/.local`（→ `/app/.local/share`）、`docker/qq-acct2`（→ `/app/qq-acct2`）。这些目录通过 `.git/info/exclude` 在本地忽略，不进 git。

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

- `hostname: DESKTOP-TYPE-13`（与宿主机电脑主机名一致）
- `mac_address: 02:42:ac:11:00:5a`

同时，持久化的机器码文件保存在宿主机的 `./data/config/machine-id`，容器启动时会自动读取并创建到 `/etc/machine-id` 的软链接。**不要手动覆写这个文件**：删除它后容器下次启动会用 `dbus-uuidgen` 自动生成新机器码（`start.sh` 仅在文件不存在时生成）。

### 更换设备指纹（主动让 QQ 重新扫码）

账号登录态反复失效/被判定"新设备"时，可整套更换设备指纹，让三个账号作为全新设备重新扫码登录。**会作废所有现有登录态**，三账号都要重新扫码。步骤：

1. 改 [`docker/docker-compose.yml`](docker/docker-compose.yml) 的 `snowluma` 服务：`hostname` 和 `mac_address`（hostname 用宿主机电脑主机名，mac 换一个 `02:42:ac:11:00:xx` 末尾值）。
2. **删除**宿主机 `./data/config/machine-id`（不要手写，让容器自动生成），容器启动会自动生成新机器码并软链到 `/etc/machine-id`。
3. 重建容器：`cd e:/SnowLuma/docker && docker compose up -d snowluma`。
4. 验证容器内三项指纹：`docker exec snowluma sh -c 'cat /etc/hostname; cat /etc/machine-id; cat /sys/class/net/eth0/address'`。
5. noVNC（`http://localhost:6081`）扫码登录账号（主 3910448576、额外 `/app/qq-acct3` = 3910007334）。当前 `qq-acct2`（3905802962）已停用，见下文"当前账号启用状态"。

> 三项指纹（hostname + mac + machine-id）必须**全部**更换才构成全新设备；只换一项可能仍被认回旧设备。

### 多个 QQ 账号（第二个和第三个）

采用 SnowLuma 官方原生多账号支持：在 [`docker/docker-compose.yml`](docker/docker-compose.yml) 的 `snowluma` 服务里通过环境变量 `SNOWLUMA_EXTRA_QQ_HOMES` 指定额外的 QQ 数据目录，并把对应的宿主机目录挂进去。容器内 SnowLuma 进程会在主账号登录后自动拉起这些额外账号。若某账号未登录，访问 noVNC 桌面扫码即可：VNC 端口 `5900`，noVNC 网页端口 `6081`。

> **本机账号归属（重要，勿乱，以实际对应为准）**：主 `/app` = 3910448576，`/app/qq-acct2` = 3905802962，`/app/qq-acct3` = 3910007334。**每个 HOME 必须且只能承载一个账号**。目录名（acct2/acct3）与 QQ 数字号无直接对应，改 compose 时以这份实际归属为准，勿按目录名想当然。

> **当前账号启用状态（2026-08-10）**：`qq-acct2`（3905802962）已停用 —— compose 中 `SNOWLUMA_EXTRA_QQ_HOMES` 只含 `/app/qq-acct3`，且 `./qq-acct2:/app/qq-acct2` 挂载已注释。其数据保留在宿主机 `./qq-acct2`。重新启用：取消卷挂载注释并把 `/app/qq-acct2` 加回 `SNOWLUMA_EXTRA_QQ_HOMES`，再 `docker compose up -d snowluma`。

> **多账号登录态排查**：账号反复"新设备/被踢下线"通常是 **HOME 间账号数据错乱**（同一账号的 `nt_qq_<hash>` 大目录、`Partitions/qqnt_<uin>` 分区、`global/nt_data/Login/.<uin>` 凭证散落多个 HOME，导致多实例同账号互踢）。排查方法：
> - 查各 HOME 的 `global/nt_data/Login/` —— 应只含该 HOME 账号的 `.uin` 文件
> - 查各 HOME 的 `Partitions/qqnt_<uin>` 和 `nt_qq_*` 的 `nt_data/UnitedConfig/<uin>` —— 确认每个账号数据只在目标 HOME
> - 修复：停容器 → 把不属于该 HOME 账号的 `nt_qq_*`/`qqnt_<uin>`/`qq-browser-<uin>`/`.uin` **移动（备份）到宿主机** → 重启 → 必要时对受影响的额外账号在 noVNC 重新扫码一次。被移动的多余副本可放 `e:/SnowLuma/.local/backup/` 留作回滚。

---

## 二、本地构建镜像（测试未合并的改动）

当本地改了 `packages/` 下的源码、还没合并进官方镜像，需要在容器里实测时，用本地构建的 `snowluma:local` 镜像。

> 原理：官方镜像 = 基础环境（QQ + noVNC + 系统依赖）+ `SnowLuma.Framework.tar.gz`（打包后的运行产物）。本地构建只替换运行产物这一层，基础环境复用官方镜像 `motricseven7/snowluma:latest`，对应同级目录 [`../SnowLuma.Docker.Framework/Dockerfile.local`](../SnowLuma.Docker.Framework/Dockerfile.local)。
>
> ⚠️ **不要直接用 [`../SnowLuma.Docker.Framework/Dockerfile`](../SnowLuma.Docker.Framework/Dockerfile) 全量构建**：它会从 `dldir1v6.qq.com` 下载 `linuxqq_*.deb`，而该地址已加防盗链，直接请求返回 404（`Resource not found`）。只有 `Dockerfile.local` 的 `FROM motricseven7/snowluma:latest` + `COPY tarball` 方式可用。

### 步骤 0：安装依赖（重要前置）

本地构建前**必须先 `pnpm install`**，否则前端构建会报 `@snowluma/common/log-sanitize` 无法解析（workspace 链接未刷新）：

```powershell
npx pnpm install
```

### 步骤 1：构建 Linux 运行产物（含 WebUI）

容器是 Linux/x64，必须指定目标平台交叉打包，并开启 WebUI：

```powershell
cd e:/SnowLuma/packages/core
npx pnpm exec cross-env SNOWLUMA_TARGET=linux-x64 BUILD_WEBUI=true vite build
```

产物输出到 `e:/SnowLuma/dist/`，包含 `index.mjs`、若干 chunk、`native/`（linux-x64 原生模块）。

> 关键点：
> - `SNOWLUMA_TARGET=linux-x64` —— 否则会打包 Windows 的 `.dll/.node`，容器里加载失败。
> - `BUILD_WEBUI=true` —— 否则 `__BUILD_WEBUI__` 为 false，WebUI（5099）整段不会启动。

### 步骤 2：构建 WebUI 前端 `client/`

直接构建前端（不要从官方镜像拷 `client/`，旧版会显示旧版本号且配置结构不匹配导致「保存失败：historySync must be an object」）：

```powershell
npx pnpm --filter webui exec vite build
```

产物输出到 `e:/SnowLuma/dist/client/`。`__APP_VERSION__` 在构建时从根 `package.json` 注入（[`packages/webui/vite.config.ts`](packages/webui/vite.config.ts)），所以版本号自动跟随仓库版本。

> ⚠️ 若误从旧官方镜像拷过 `client/`，`dist/client/` 里会残留旧 `index-*.js`，但 `index.html` 只引用新构建的文件，不影响运行。

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

> v1.14.1+：`Dockerfile.local` 用 `${SNOWLUMA_HOME}`（基础镜像 ENV = `/app/runtime`）解压产物，无需改 Dockerfile。

### 步骤 5：切换 compose 到本地镜像并启动

把 [`docker/docker-compose.yml`](docker/docker-compose.yml) 中 `snowluma` 服务的镜像改为本地镜像，并确认数据挂载是新布局：

```yaml
  snowluma:
    image: snowluma:local      # 测试时用本地；回归官方时改回 motricseven7/snowluma:latest
    volumes:
      - ./data:/app/data       # v1.14.1+：不再是 /app/snowluma-data
```

然后重建：

```powershell
cd e:/SnowLuma/docker
docker compose up -d snowluma
```

> ⚠️ 首次用新镜像启动会执行 `start.sh` 的 `chown -R`（遍历 `/app` 下的数据目录），**耗时约 1-2 分钟**，期间 PID 1 停在 `bash /root/start.sh` 属正常，等它进入 supervisord 即可。

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
| 本地镜像 WebUI（5099）打不开 | 构建时漏了 `BUILD_WEBUI=true`，或漏了步骤 2 构建 `client/` |
| 容器启动报 `Cannot find module .../config-xxx.js` | `dist` 打包不完整，确认步骤 3 在 `dist` 目录内 `tar ... .` 打包了全部 chunk |
| 容器里加载 native 报错 | 构建时漏了 `SNOWLUMA_TARGET=linux-x64`，打成了 Windows 产物 |
| TTS/插件发文件报路径找不到 | 文件路径需在容器内可见，确认 `docker-compose.yml` 里挂载了对应宿主机目录 |
| `docker compose` 报「找不到指定路径」 | 在 `e:/SnowLuma/docker` 目录内直接跑 `docker compose ...`，或在根目录用 `-f docker/docker-compose.yml` |
| WebUI 显示旧版本号 / 保存配置报 `historySync must be an object` | `client/` 是从旧官方镜像拷的。用步骤 2 重新构建前端 |
| 重建后卡在 `bash /root/start.sh`（PID 1） | 首次用新镜像在 `chown -R /app` 遍历数据目录，**等 1-2 分钟**进入 supervisord 即可，别急着重启 |
| 新版找不到数据 / 登录态丢失 | 确认 compose 挂载已用新布局 `./data:/app/data`（v1.14.1+），旧路径 `/app/snowluma-data` 已废弃 |
| updater 容器反复重启 | `docker logs snowluma-updater`。`set -o pipefail` 需 bash（Dockerfile `CMD ["bash", ...]`） |
| 自动更新 push 失败 128 | run.sh 已对 GH_TOKEN 做 trim；用户名用 `tt-P607`，勿用 `x-access-token` |
| 容器内数据目录全报 `EIO: i/o error` / QQ 进程 FATAL | Docker Desktop 9p 挂载层瞬时故障（睡眠唤醒/盘被占用/句柄泄漏）。宿主机数据完好；**用 `docker start snowluma` 启动**即可恢复，勿用 `docker compose up` 重建 |
| `docker compose up` 报 `mkdir /run/desktop/mnt/host/e: file exists` | Docker Desktop 29.x + containerd snapshotter（`UseContainerdSnapshotter: true`）在**重建容器**时的 bind mount 路径 bug。`docker run`/`docker start` 不触发；**容器停止用 `docker start snowluma` 启动**，避免重建 |

---

## 六、自动更新器（sidecar 容器）

检测官方 `upstream/dev` 更新 → `git merge` 合并 → 构建 Linux 产物 + WebUI → `docker cp` 热替换到容器 → `supervisorctl restart snowluma` → `git push` 回 fork `origin/dev`。只重启 snowluma 进程，**QQ 不重启**，登录时长保持。

> **登录时长语义**：`#sl` 时长 = QQ 进程登录会话时长。`qq` 与 `snowluma` 是 supervisord 两个独立 program（[`supervisord.conf`](../SnowLuma.Docker.Framework/supervisord.conf)）。只 `restart snowluma` 则 QQ 一直在线，时长持续累计；重建容器或 `restart qq` 则时长归零（免扫码秒回，但重置）。

**文件**：[`docker/updater/Dockerfile`](docker/updater/Dockerfile)、[`docker/updater/run.sh`](docker/updater/run.sh)、[`docker/docker-compose.yml`](docker/docker-compose.yml) 的 `snowluma-updater` 服务。

**关键约束**：
- 容器内完整克隆 fork（`origin`=fork，`upstream`=官方），**勿用 `--depth 1` 浅克隆**（merge 需共同祖先）
- merge 冲突 → 写 `.paused` 标记并停止（不构建/替换/push），人工处理后 `git push origin dev` 自动恢复
- 间隔 `UPDATE_INTERVAL=600`（10 分钟）；源码/依赖存命名卷，重启不重克隆
- push 凭据：`gho_` token 用「用户名+token」内联 URL，**用户名必须是 `tt-P607`**（非 `x-access-token`），且 **GH_TOKEN 需 trim**（CMD 注入带尾随空格）

**操作**：

```powershell
docker logs snowluma-updater --tail 50        # 日志
docker compose -f docker/docker-compose.yml restart snowluma-updater   # 手动触发一轮

# GH_TOKEN 注入启动（务必 --no-deps，避免连带 recreate snowluma 导致 QQ 重启）
for /f %i in ('gh auth token') do set GH_TOKEN=%i & docker compose -f docker/docker-compose.yml up -d --no-deps snowluma-updater
```

---

## 命令速查

```powershell
# —— 官方更新 ——
docker compose -f docker/docker-compose.yml pull snowluma
docker compose -f docker/docker-compose.yml up -d snowluma

# —— 本地构建测试 ——
npx pnpm install                                      # 前置：刷新 workspace 链接，否则前端报 @snowluma/common 解析失败
cd e:/SnowLuma/packages/core
npx pnpm exec cross-env SNOWLUMA_TARGET=linux-x64 BUILD_WEBUI=true vite build
npx pnpm --filter webui exec vite build               # 构建 WebUI 前端 client/（v1.14.1+ 不再从镜像拷）
cd e:/SnowLuma/dist; tar -czf ../../SnowLuma.Docker.Framework/SnowLuma.Framework.tar.gz .
cd e:/SnowLuma; docker build -t snowluma:local -f ../SnowLuma.Docker.Framework/Dockerfile.local ../SnowLuma.Docker.Framework/
cd e:/SnowLuma/docker; docker compose up -d snowluma   # image 需先改为 snowluma:local；数据挂载 /app/data

# —— PR ——
git fetch upstream; git merge upstream/dev
pnpm typecheck; pnpm test
git add .; git commit -m "fix(scope): subject"
git push origin dev
gh pr create --repo SnowLuma/SnowLuma --base dev --head tt-P607:dev --title "..." --body-file .local/pr-body.md
```
