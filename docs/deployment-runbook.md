# AgentNest 云端 Demo 部署手册

## 1. 范围

使用本地 `config.txt`，在一台干净云服务器上部署：

```text
OpenClaw 官方最新稳定版
AgentNest Control Plane
Data Gateway Mock
External Gateway Mock
PostgreSQL
```

第一版不部署 Redis、MinIO、Kafka、Kubernetes 或生产级密钥管理平台。

---

## 2. 原则

1. 可重复：同一服务器重复执行不会创建冲突资源；
2. 最小暴露：默认 loopback 或 Docker 私网；
3. 不破坏：只操作 `REMOTE_WORKDIR` 和本项目资源；
4. 不泄密：不回显 `config.txt`、密码、私钥或模型 Key；
5. Stable only：禁止 OpenClaw beta/dev；
6. 可验证：部署后自动运行三层链路、隔离、生命周期和恢复测试。

---

## 3. `config.txt`

格式参考 `config.example.txt`。

最低字段：

```text
SSH_HOST
SSH_PORT
SSH_USER
SSH_PRIVATE_KEY_PATH
REMOTE_WORKDIR
OPENCLAW_CHANNEL=stable
OPENCLAW_VERSION=AUTO
MODEL_PROVIDER
MODEL_NAME
MODEL_API_KEY
POSTGRES_PASSWORD
L1_IDLE_TTL_SECONDS
L2_IDLE_TTL_SECONDS
```

可选：

```text
DEMO_API_TOKEN
CONTROL_PLANE_PORT
DATA_GATEWAY_MOCK_PORT
EXTERNAL_GATEWAY_MOCK_PORT
POSTGRES_PORT
```

读取要求：

- `config.txt` 已 Git ignore；
- 不直接 `source config.txt`；
- 使用简单 KEY=VALUE parser；
- 错误只显示缺失字段名，不显示值；
- 不把内容复制进报告或远端 release 目录。

---

## 4. 只读 Preflight

部署前运行：

```bash
pnpm demo:preflight
```

检查：

- `config.txt` 存在；
- SSH key 路径存在；
- SSH 可连接；
- 远端 OS/arch；
- CPU、内存、磁盘；
- Node/Docker/Git 可用性；
- 目标端口占用；
- `REMOTE_WORKDIR` 安全且不是 `/`、`/home`、`/root` 等宽目录；
- 不存在同名但非本项目管理的容器或目录；
- OpenClaw stable 版本解析结果。

Preflight 不安装、不删除、不修改服务。

建议 Demo 资源：

```text
2–4 vCPU
4–8 GiB RAM
20 GiB free disk
Ubuntu 22.04/24.04 或兼容 Linux
```

资源不足时如实报告。

---

## 5. OpenClaw Stable 版本

实现：

```text
scripts/deploy/resolve-openclaw-stable.sh
```

算法：

1. 查询官方 GitHub Release 或 npm `latest`；
2. 排除 beta、alpha、rc、dev 和 prerelease；
3. 记录最终版本和解析来源；
4. 精确安装：

```bash
npm install -g openclaw@<resolved-version>
```

5. 验证：

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

如果官方 stable 的动态 Profile API 与文档假设不同，应选择最小可运行方案并记录限制，不得改用 beta。

---

## 6. 远端目录

```text
${REMOTE_WORKDIR}/
  current/
  source/
  config/
  openclaw-state/
  postgres-data/
  runtime-persistence/
  reports/
```

要求：

- 只操作该根目录；
- 机密文件权限 `0600`；
- runtime/openclaw-state 不允许无关系统用户读取；
- 不把私钥复制到远端；
- 部署日志不打印完整连接串。

不要求 release symlink、蓝绿部署或自动回滚平台。保留前一次可用配置备份即可。

---

## 7. Docker Compose

最少服务：

```text
postgres
control-plane
data-gateway-mock
external-gateway-mock
```

OpenClaw 可以：

- 使用官方推荐宿主 daemon；或
- 作为受控容器运行。

选择兼容当前 stable 的最小方案，并在 README 记录。

服务网络：

```text
PostgreSQL: Docker private network
Data/External Gateway Mock: Docker private network
Control Plane: 127.0.0.1 或 private network
OpenClaw Gateway: 127.0.0.1
Admin/Test API: 127.0.0.1 或 private network
```

外部验证优先使用 SSH tunnel。

---

## 8. 部署顺序

```text
1. 创建 REMOTE_WORKDIR 子目录
2. 上传/拉取 AgentNest source
3. 安装 Node/pnpm/Docker（缺失时）
4. 解析并安装 OpenClaw stable
5. 启动 PostgreSQL
6. 执行 migration 和 Demo seed
7. 启动 Gateway Mock
8. 启动 Control Plane
9. 安装/启用 Tenant Runtime Plugin
10. 创建 Main Agent 配置
11. 启动 OpenClaw Gateway
12. 运行 health/smoke test
13. 运行 demo:verify
```

脚本必须可重复运行。

---

## 9. OpenClaw 配置

配置必须以实际 stable Schema 为准。

Demo 至少包含：

```text
main Profile
Tenant Runtime Plugin
L2 sessions_spawn 配置
per-agent workspace/agentDir
per-agent Skill/Tool allowlist
```

结构化更新配置，禁止 sed/regex 直接替换 JSON。

如果动态 L1 Profile 热加载不可用，可选择：

1. 官方配置 reload；
2. 预创建有限 Profile 模板；
3. 受控多实例方式。

只要能证明三个 tenant/biz scope 的真实隔离即可。

---

## 10. 一键命令

最终提供：

```bash
pnpm demo:preflight
pnpm demo:deploy
pnpm demo:status
pnpm demo:verify
```

要求：

- 失败返回非零退出码；
- 不吞错误；
- 日志脱敏；
- `demo:deploy` 可重复执行；
- 可选支持 `--dry-run`，但不要求复杂发布系统。

---

## 11. `demo:verify`

必须验证：

1. OpenClaw stable version；
2. Control Plane/PostgreSQL/OpenClaw 健康；
3. 三个 L1 scope 创建；
4. LEGAL 和 ROBOT_DOG 三层 E2E；
5. Skill 隔离；
6. Tool/action/tenant resource 隔离；
7. Memory Canary 隔离；
8. L2 TTL checkpoint/unload；
9. L1 TTL checkpoint/unload；
10. L1 restore 后 logical ID 不变、runtime ID 变化。

输出简洁测试摘要和失败原因。

---

## 12. 报告

生成：

```text
reports/deployment-summary.json
reports/verification-summary.json
```

记录：

```text
AgentNest commit
OpenClaw version
Node/pnpm/Docker version
服务健康状态
真实 OpenClaw 测试列表
Mock Tool 测试列表
隔离测试结果
生命周期测试结果
已知限制
```

不得记录：

```text
config.txt 原文
密码
SSH 私钥
模型/API Key
完整连接串
未脱敏 Session Transcript
```

---

## 13. 项目清理

可提供：

```bash
scripts/deploy/destroy-project-only.sh --dry-run
scripts/deploy/destroy-project-only.sh --confirm-agentnest
```

只能停止/删除：

- 标记为 AgentNest 的容器和网络；
- `REMOTE_WORKDIR` 下项目文件；
- 本项目创建的 OpenClaw Profile/Plugin 配置。

默认保留 PostgreSQL 数据。不要修改防火墙全局策略、重装整机或删除其他项目资源。

---

## 14. 明确不做

云端 Demo 不要求：

```text
Redis
MinIO
Kafka/Outbox
Capability signing service
mTLS/PKI
Kubernetes
蓝绿发布平台
多节点 HA
灾备和性能压测
```

这些内容不应阻塞三层 Agent 验证。
