# AgentNest 云端 Demo 部署手册

## 1. 范围

使用本地 `config.txt`，在一台干净云服务器上部署并验证：

```text
OpenClaw 官方最新稳定版
AgentNest Control Plane
Data Gateway Mock
External Gateway Mock
PostgreSQL
```

第一版不部署 Redis、MinIO、Kafka、Kubernetes、Capability Token 服务或生产级密钥管理平台。

---

## 2. 部署原则

1. **可重复**：同一服务器重复执行不会创建冲突资源；
2. **不破坏**：只操作 `REMOTE_WORKDIR` 和本项目容器；
3. **不泄密**：不回显 `config.txt`、SSH 密码、私钥、模型 Key 或数据库密码；
4. **最小暴露**：默认使用 loopback 或 Docker 私网；
5. **Stable only**：只安装 OpenClaw 官方稳定版；
6. **Demo 优先**：不要为部署增加 PKI、堡垒机、企业 IAM、复杂发布平台或其他非必要安全系统；
7. **可验证**：部署后自动运行三层链路、隔离、生命周期和恢复测试。

---

## 3. `config.txt`

格式参考 `config.example.txt`。

### 3.1 基础字段

```text
SSH_HOST
SSH_PORT
SSH_USER
SSH_AUTH_MODE=key|password
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

### 3.2 SSH 认证二选一

Key 模式：

```text
SSH_AUTH_MODE=key
SSH_PRIVATE_KEY_PATH=/path/to/key
SSH_PASSWORD=
```

Password 模式：

```text
SSH_AUTH_MODE=password
SSH_PRIVATE_KEY_PATH=
SSH_PASSWORD=<server password>
```

用户名密码登录是本 Demo 明确支持的方式。不能因为没有 SSH 私钥而阻塞部署。

Password 模式实现要求保持简单：

- 可以使用 `sshpass -e`，通过临时环境变量 `SSHPASS` 传递；或
- 使用 Node SSH library 的 password 字段；
- 不得把密码放进可见的命令行参数；
- 不得在 stdout、stderr、日志、Issue 或报告中打印密码；
- 子进程结束后清理临时环境变量；
- 不建设 PKI、Vault、堡垒机或密码轮换平台。

### 3.3 可选字段

```text
DEMO_API_TOKEN
CONTROL_PLANE_PORT
DATA_GATEWAY_MOCK_PORT
EXTERNAL_GATEWAY_MOCK_PORT
POSTGRES_PORT
SSH_BASTION
```

### 3.4 文件规则

- `config.txt` 必须被 Git ignore；
- 文件权限应为 `0600`；
- 不直接 `source config.txt`；
- 使用简单 KEY=VALUE parser；
- parser 只读取已知字段；
- 错误只显示字段名，不显示值；
- 不把配置内容复制进报告或远端源码目录。

当权限已经是 `0600` 且认证字段完整时，应继续执行 preflight，不要反复增加新的安全前置条件。

---

## 4. 只读 Preflight

运行：

```bash
pnpm demo:preflight
```

Preflight 只允许读取，不能安装、删除或修改远端服务。

检查：

```text
config.txt 存在且权限为 0600
所选 SSH 认证方式字段完整
SSH 可连接
远端 OS / architecture
CPU / memory / free disk
Node / npm / pnpm / Docker / Git 可用性
目标端口占用
REMOTE_WORKDIR 是否存在、是否可写
REMOTE_WORKDIR 不是 /、/home、/root 等宽目录
是否存在同名但非本项目管理的容器
OpenClaw 最新 stable 版本解析结果
```

Password 模式示意：

```bash
SSHPASS="$SSH_PASSWORD" sshpass -e ssh \
  -o StrictHostKeyChecking=accept-new \
  -p "$SSH_PORT" \
  "$SSH_USER@$SSH_HOST" \
  'uname -a'
```

示意命令不能打印 `SSHPASS` 或 `SSH_PASSWORD`。实现也可以使用 Node SSH library。

Preflight 报告只包含：

```text
连接成功/失败
OS / arch
CPU / memory / disk
工具版本
端口状态
REMOTE_WORKDIR 状态
OpenClaw stable 解析结果
真正的部署阻塞项
```

不包含任何密码、Key 内容、模型 Key 或完整连接串。

建议 Demo 资源：

```text
2–4 vCPU
4–8 GiB RAM
20 GiB free disk
Ubuntu 22.04/24.04 或兼容 Linux
```

资源不足时如实报告，但不要顺手设计集群或高可用方案。

---

## 5. OpenClaw Stable 版本

实现：

```text
scripts/deploy/resolve-openclaw-stable.sh
```

流程：

1. 查询 OpenClaw 官方 GitHub Release 或 npm `latest`；
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

如果 stable 版动态 Profile API 与文档假设不同，选择最小可运行方案并记录限制，不得切换 beta，也不得先修改 OpenClaw 核心源码。

---

## 6. 远端目录

所有项目内容限制在：

```text
${REMOTE_WORKDIR}/
  source/
  config/
  openclaw-state/
  postgres-data/
  runtime-persistence/
  reports/
```

要求：

- 只操作该根目录；
- 远端环境文件权限 `0600`；
- 不复制本地 SSH 私钥；
- 不把本地 `config.txt` 原样上传；
- 只生成服务需要的最小远端环境文件；
- 部署日志不打印完整连接串。

不要求 release symlink、蓝绿部署或自动回滚平台。保留一份可用配置备份即可。

---

## 7. Docker Compose

最少服务：

```text
postgres
control-plane
data-gateway-mock
external-gateway-mock
```

OpenClaw 可以使用官方推荐 daemon，也可以作为受控容器运行。选择与当前 stable 最兼容、实现最少的方式，并记录实际选择。

部署优先拉取 Docker Hub 的 Node/PostgreSQL Official Images。若目标机无法访问 Docker Hub，则自动回退到 DaoCloud 对相同 Official Image 路径的国内镜像前缀，并把实际镜像源写入脱敏部署报告；脚本不会修改 Docker daemon 的全局 registry 配置。

默认网络：

```text
PostgreSQL: Docker private network
Data/External Gateway Mock: Docker private network
Control Plane: 127.0.0.1 或 Docker private network
OpenClaw Gateway: 127.0.0.1
Admin/Test API: 127.0.0.1 或 Docker private network
```

外部验证优先使用 SSH tunnel。

---

## 8. 部署顺序

```text
1. 完成只读 preflight
2. 创建 REMOTE_WORKDIR 子目录
3. 上传或拉取 AgentNest source
4. 安装缺失的 Node/pnpm/Docker/Git
5. 解析并安装 OpenClaw stable
6. 启动 PostgreSQL
7. 执行 migration 和 Demo seed
8. 启动 Data/External Gateway Mock
9. 启动 Control Plane
10. 安装/启用 Tenant Runtime Plugin
11. 创建 Main Agent 配置
12. 启动 OpenClaw Gateway
13. 运行 health/smoke test
14. 运行 pnpm demo:verify
```

部署脚本必须可重复运行。第二次运行不得创建重复数据库记录、重复容器或重复 Agent 配置。

---

## 9. OpenClaw 配置

配置以实际 stable Schema 为准。

Demo 至少包含：

```text
main Profile
Tenant Runtime Plugin
L2 sessions_spawn 配置
per-agent workspace / agentDir
per-agent Skill allowlist
per-agent Tool allowlist
```

结构化更新配置，禁止用 sed/regex 直接替换 JSON。

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
pnpm demo:report
```

要求：

- 失败返回非零退出码；
- 不吞错误；
- 日志脱敏；
- `demo:deploy` 可重复执行；
- 不要求复杂发布系统。

---

## 11. `demo:verify`

必须验证：

1. OpenClaw stable version；
2. Control Plane、PostgreSQL、OpenClaw 健康；
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

本地会保留对应的脱敏验收证据：

```text
artifacts/reports/phase-6-deployment-summary.json
artifacts/reports/phase-6-status.json
artifacts/reports/phase-6-verification-summary.json
artifacts/reports/phase-6-summary.json
artifacts/reports/phase-6-summary.md
```

`demo:report` 不连接服务器，也不读取 `config.txt`；它只汇总已经生成的 JSON evidence。缺少任一必需 evidence 时仍会生成 `INCOMPLETE` 摘要，但命令退出码非零。只有真实 OpenClaw、远端平台、隔离、生命周期和恢复证据全部通过时才输出 `PASS`。

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
SSH 密码或私钥
模型/API Key
数据库密码
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

只能停止或删除：

- 标记为 AgentNest 的容器和网络；
- `REMOTE_WORKDIR` 下项目文件；
- 本项目创建的 OpenClaw Profile/Plugin 配置。

默认保留 PostgreSQL 数据。不要修改防火墙全局策略、重装整机或删除其他项目资源。

---

## 14. 明确不做

云端 Demo 不要求：

```text
SSH PKI / Vault / 堡垒机平台
Redis
MinIO
Kafka / Outbox
Capability signing service
mTLS / 零信任网络
Kubernetes
蓝绿发布平台
多节点 HA
灾备和性能压测
```

这些内容不应阻塞三层 Agent 验证。
