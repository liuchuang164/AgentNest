# 云端部署运行手册

## 1. 适用范围

本手册规定 Codex 如何使用本地 `config.txt`，在用户提供的干净云服务器上部署 AgentNest 和 OpenClaw 最新稳定版。

仓库是公开的，`config.txt` 只存在于执行环境，禁止提交。

---

## 2. 部署原则

1. 可重复：同一服务器重复执行不会产生冲突实例；
2. 可审计：记录版本、commit、配置 hash 和部署时间；
3. 最小权限：创建独立项目用户和目录；
4. 最小暴露：默认所有服务仅 loopback/Docker 私网；
5. 不破坏：只操作 `REMOTE_WORKDIR` 和本项目命名资源；
6. 不泄密：不回显 config、密码、Token、私钥；
7. 可回滚：保留前一个已知可用部署清单和配置；
8. Stable only：禁止 beta/dev。

---

## 3. config.txt

格式参考 `config.example.txt`。

脚本读取要求：

- 只接受明确 allowlist 的变量；
- 拒绝未知高风险字段；
- 拒绝 world-readable 文件；
- 建议权限 `0600`；
- 不使用 `source config.txt` 直接执行任意 shell；
- 使用安全 parser 读取 `KEY=VALUE`；
- 错误信息只显示字段名，不显示值。

部署前检查：

```text
SSH_HOST
SSH_PORT
SSH_USER
SSH_PRIVATE_KEY_PATH
REMOTE_WORKDIR
OPENCLAW_CHANNEL=stable
MODEL_PROVIDER
MODEL_NAME
MODEL_API_KEY
CAPABILITY_TOKEN_SIGNING_SECRET
POSTGRES_PASSWORD
MINIO_ROOT_PASSWORD
```

缺失即停止，不得生成假的模型 key。

---

## 4. 本地 preflight

Codex 必须实现：

```bash
scripts/deploy/preflight.sh
```

检查：

- `config.txt` 存在且权限安全；
- SSH key 文件存在；
- Git 工作树状态；
- pnpm/npm/docker/ssh 客户端；
- config 无明显占位符；
- 远端 SSH 可连通；
- 远端 OS/arch；
- 可用磁盘、内存、CPU；
- 端口占用；
- 当前用户 sudo 能力；
- `REMOTE_WORKDIR` 不为空、不为 `/`、`/home`、`/root`、`/opt` 等宽目录；
- 远端不存在同名但非本项目管理的资源。

建议最低 Demo 资源：

```text
4 vCPU
8 GiB RAM
40 GiB free disk
Ubuntu 24.04 LTS or compatible Linux
```

资源不足时报告事实，不要偷偷关闭组件以假装成功。

---

## 5. 解析 OpenClaw 最新稳定版

实现：

```bash
scripts/deploy/resolve-openclaw-stable.sh
```

算法：

1. 查询官方 GitHub releases API 或 npm `openclaw` dist-tags；
2. 只接受 `prerelease=false` 的 release，或 npm `latest`；
3. 拒绝版本字符串包含 `beta`、`alpha`、`rc`、`dev`；
4. 交叉校验 release tag 与 npm version（可用时）；
5. 当 `OPENCLAW_VERSION` 非 `AUTO` 时，验证它确实是稳定 release；
6. 保存解析来源和响应摘要 hash；
7. 输出仅版本号，不执行安装。

当前文档基线：`2026.6.11`。脚本运行时以官方实时 stable 为准。

安装必须精确 pin：

```bash
npm install -g openclaw@<resolved-stable-version>
```

禁止仅使用不可复现的 `@latest` 后不记录解析结果。

---

## 6. 远端目录

所有项目数据位于：

```text
${REMOTE_WORKDIR}/
  releases/<git-sha>/
  current -> releases/<git-sha>
  shared/
    config/
    secrets/
    openclaw-state/
    postgres/
    redis/
    minio/
    reports/
  backups/
```

权限：

- 目录属于 `REMOTE_PROJECT_USER`；
- secrets `0700`，文件 `0600`；
- OpenClaw state 和各 Agent workspace 不允许其他系统用户读取；
- 不把 secrets 放 release 目录。

---

## 7. 基础软件

推荐远端：

- Node.js 24；
- pnpm 当前稳定版并通过 Corepack pin；
- Docker Engine + Compose plugin；
- curl、jq、git、ca-certificates；
- 不安装不需要的桌面环境。

安装脚本必须检测现有兼容版本，避免重复覆盖。系统包变更写入部署日志。

---

## 8. OpenClaw 安装和验证

步骤：

1. 安装精确稳定版本；
2. `openclaw --version`；
3. 生成最小配置；
4. 配置 Gateway loopback；
5. 配置 Main Agent；
6. 配置非 Main Agent sandbox；
7. 配置 Sub-agent 参数；
8. 安装 AgentNest Tenant Runtime Plugin；
9. `openclaw doctor`；
10. `openclaw config schema` 并保存 hash；
11. 启动 Gateway；
12. `openclaw gateway status`；
13. 通过 loopback health/CLI 验证。

OpenClaw 配置示意，最终字段必须以实际稳定版 Schema 为准：

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "non-main" },
      subagents: {
        maxSpawnDepth: 1,
        maxChildrenPerAgent: 5,
        maxConcurrent: 8,
        archiveAfterMinutes: 60
      }
    },
    list: [
      {
        id: "main",
        default: true,
        workspace: "/opt/agentnest-demo/shared/openclaw-state/workspace-main",
        tools: {
          allow: ["tenant_agent.ensure", "tenant_agent.dispatch", "tenant_agent.status"]
        },
        skills: []
      }
    ]
  }
}
```

Codex 不得照抄未经 Schema 验证的示意配置。

---

## 9. AgentNest 服务部署

Docker Compose 至少包含：

```text
postgres
redis
minio
minio-init
control-plane
data-gateway-mock
external-gateway-mock
```

OpenClaw 可以是宿主 daemon 或受控容器，选择后写 ADR。第一版优先官方推荐 daemon，以降低容器内配置/Session 管理不确定性；其他服务可容器化。

部署顺序：

1. PostgreSQL/Redis/MinIO；
2. migration；
3. Demo seed；
4. Gateway Mock；
5. Control Plane；
6. OpenClaw；
7. Plugin；
8. readiness；
9. smoke test；
10. 完整验证。

---

## 10. 网络与端口

默认：

```text
OpenClaw: 127.0.0.1:18789
Control Plane: 127.0.0.1:18080 or private Docker network
Data Gateway Mock: private network:18081
External Gateway Mock: private network:18082
PostgreSQL/Redis/MinIO: private network only
```

验证 SSH tunnel 示例：

```bash
ssh -N \
  -L 18080:127.0.0.1:18080 \
  -L 18789:127.0.0.1:18789 \
  -p "$SSH_PORT" \
  -i "$SSH_PRIVATE_KEY_PATH" \
  "$SSH_USER@$SSH_HOST"
```

脚本不得在日志打印完整 SSH 命令中的敏感路径之外的 secret；私钥路径本身通常可显示，但建议也只显示 basename。

---

## 11. 部署清单

生成：

```text
artifacts/reports/deployment-manifest.json
```

字段：

```json
{
  "deployed_at": "...",
  "agentnest_git_sha": "...",
  "openclaw": {
    "channel": "stable",
    "version": "...",
    "tag": "...",
    "commit": "...",
    "install_source": "npm",
    "config_schema_sha256": "..."
  },
  "runtime": {
    "node": "...",
    "pnpm": "...",
    "docker": "...",
    "compose": "...",
    "os": "...",
    "arch": "..."
  },
  "services": {
    "control_plane": "healthy",
    "openclaw": "healthy",
    "postgres": "healthy",
    "redis": "healthy",
    "minio": "healthy"
  },
  "config_fingerprint": "sha256:..."
}
```

`config_fingerprint` 是脱敏 canonical config 的 hash，不是 config.txt 原文 hash，避免离线猜测低熵密码。

---

## 12. 一键命令

Codex 最终提供：

```bash
pnpm demo:preflight
pnpm demo:deploy
pnpm demo:status
pnpm demo:verify
pnpm demo:report
```

每个命令：

- 非交互或明确说明交互点；
- 失败退出非零；
- 不吞错误；
- 支持 `--dry-run`（部署/清理至少支持）；
- 支持 `--verbose`，但仍需脱敏。

---

## 13. 回滚

当新 release readiness 失败：

1. 不切换 `current` symlink；
2. 保持旧服务；
3. 保存失败部署摘要；
4. 不删除新 release，便于诊断；
5. 若 OpenClaw 配置热加载失败，保持 last-known-good；
6. 数据 migration 只能向前兼容或提供明确回滚脚本；
7. 不允许自动删除数据库。

---

## 14. 项目级清理

提供：

```bash
scripts/deploy/destroy-project-only.sh --dry-run
scripts/deploy/destroy-project-only.sh --confirm-agentnest
```

只能清理：

- 明确 label 为 AgentNest 的容器/volume/network；
- `REMOTE_WORKDIR` 下的项目文件；
- AgentNest systemd unit；
- 本项目 OpenClaw Profile/Plugin 配置。

默认保留 PostgreSQL/MinIO 数据。数据销毁必须另有 `--purge-data` 和二次确认，Demo 验证一般不执行。

---

## 15. 远端验证证据

收集脱敏内容：

- 服务状态；
- 精确版本；
- Agent Profile 列表（内部 ID）；
- workspace/agentDir 路径 hash；
- 测试 summary；
- Trace IDs；
- Capability Snapshot IDs；
- Reaper 结果；
- restart/recovery 结果。

禁止收集：

- config.txt；
- `.env`；
- Token；
- 模型请求全文；
- 私钥；
- 数据库 dump；
- 未脱敏 Transcript。
