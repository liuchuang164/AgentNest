# CODEX_TASK.md — AgentNest Demo 实施任务书

## 0. 工作方式

Codex 必须先阅读：

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture.md`
4. `docs/contracts.md`
5. `docs/security-isolation.md`
6. `docs/lifecycle-persistence.md`
7. `docs/validation-test-plan.md`

然后按本任务书阶段开发。

本项目是技术验证 Demo。优先让三层 Agent 链路真实运行，再补最小隔离、生命周期和恢复。禁止主动实现生产级零信任、Capability Token、Outbox、Redis 分布式锁、MinIO、Kafka、Kubernetes 或完整 IAM。

每个阶段：

- 小步提交；
- 保持主干可构建；
- 运行本阶段相关测试；
- 更新文档和 Issue #1；
- 不提交 `config.txt`、`.env` 或远端密钥；
- 不伪造测试输出。

---

# Phase 1：工程骨架与领域模型

## 目标

建立可运行的 TypeScript/pnpm 工程、PostgreSQL Schema、基础 API 和测试骨架。

## 建议目录

```text
apps/
  control-plane/
  data-gateway-mock/
  external-gateway-mock/
packages/
  contracts/
  persistence/
  openclaw-adapter/
  tenant-runtime-plugin/
  test-support/
skills/
  legal-evidence-check/
  robot-dog-health-check/
infra/
  docker-compose.yml
  postgres/migrations/
  openclaw/
scripts/
  deploy/
  verify/
tests/
  e2e/
  isolation/
  lifecycle/
```

## 必须交付

- `package.json`、`pnpm-workspace.yaml`、TypeScript strict 配置；
- lint、typecheck、test 命令；
- Fastify API 骨架；
- PostgreSQL migration；
- Agent、RuntimeInstance、Task、Memory、Trace、ExecutionContext 领域模型；
- 状态 enum；
- fake clock；
- 基础 OpenAPI/JSON Schema；
- Unit Test 骨架。

## Gate

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

---

# Phase 2：租户业务能力与 L1 Runtime Registry

## 目标

实现 `tenant_id + biz_domain` 下的 Skill、Tool、Memory Scope 配置，以及 L1 逻辑实例创建和复用。

## 必须交付

- TenantBiz 配置表；
- Skill allowlist；
- Tool/action allowlist；
- Task template；
- 简单版本化 Capability Profile；
- `logical_agent_id` 稳定派生；
- `runtime_instance_id` 每次重建变化；
- PostgreSQL 权威状态；
- 进程内 Runtime cache；
- `ensureTenantBizAgent`；
- 三个 Demo scope seed：
  - `tenant_A + LEGAL`；
  - `tenant_A + ROBOT_DOG`；
  - `tenant_B + LEGAL`。

## 必测

- 相同 tenant/biz 复用同一 logical ID；
- 不同 tenant/biz 得到不同 logical ID；
- L2 Skill/Tool 只能取 L1 与 task template 的交集；
- 未知 Skill、Tool 或 action 拒绝；
- 路径派生无法路径穿越。

---

# Phase 3：OpenClaw L0、L1 Profile 与真实三层链路

## 目标

安装官方最新稳定版 OpenClaw，并验证 L0 Main Agent、动态/受控 L1 Profile 和 L2 `sessions_spawn`。

## 必须交付

- stable 版本解析和记录；
- OpenClaw preflight/doctor；
- `OpenClawAdapter`；
- L0 固定 `main` Profile；
- L1 Profile ensure/deactivate/inspect；
- 每个 L1 独立 workspace、agentDir、Session namespace；
- 每 L1 显式 Skill/Tool allowlist；
- 至少一种 stable 版可运行的 Profile 创建方案：
  - 官方 Config API/RPC；或
  - 结构化配置 reload；或
  - 有限模板 Profile；或
  - 受控多实例方式；
- L1 使用原生 `sessions_spawn` 创建 L2；
- L2 独立 Session。

## 必测

- L0 看不到业务 Tool；
- 三个 Demo scope 的 Profile 和运行目录不同；
- LEGAL 看不到 ROBOT_DOG Skill/Tool，反之亦然；
- 至少一条真实 L0 → L1 → L2 链路成功；
- 实际安装版本为 stable，不含 beta/alpha/rc/dev。

---

# Phase 4：Gateway Mock 与服务端执行上下文

## 目标

用最小机制验证 Tool 越权无法产生业务副作用。

## 设计

不实现 Capability Token。控制面在 PostgreSQL 中创建随机 UUID `execution_context_id`，记录：

```text
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
allowed_skills
allowed_tools + actions
resource_scope
expires_at
```

OpenClaw Plugin/Adapter 将 `execution_context_id` 传给 Gateway Mock。Gateway 从 PostgreSQL 或控制面读取权威上下文，不能相信模型 body 自报的 tenant/biz/权限。

## 必须交付

- ExecutionContext Repository；
- Data Gateway Mock；
- External Gateway Mock；
- tool/action 校验；
- tenant/biz/resource ownership 校验；
- 简单 ALLOW/DENY Trace；
- LEGAL 和 ROBOT_DOG 确定性 Mock Tool；
- 未知/过期 context 拒绝。

## Demo Tool

### LEGAL

```text
legal_case_read/read
legal_analysis_write/write
legal_research_query/query
```

### ROBOT_DOG

```text
robot_device_read/read
robot_health_write/write
robot_telemetry_enrich/query
```

## 必测

- LEGAL L2 调 Robot Tool 被拒绝；
- ROBOT_DOG L2 调 Legal Tool 被拒绝；
- 允许 Tool 但不允许 action 时拒绝；
- tenant_A context 访问 tenant_B `case_001` 时拒绝；
- 拒绝后目标业务数据不变；
- Trace 记录 DENY 原因。

---

# Phase 5：Memory、Session、Trace、生命周期和恢复

## 目标

验证 L1/L2 卸载前持久化，后续创建新运行实例并恢复必要状态。

## 必须交付

- PostgreSQL Memory Store；
- Session Summary；
- 本地持久化 volume 保存 Transcript/Snapshot；
- Trace Store；
- TaskState；
- L1/L2 `last_active_at`；
- L1 24h、L2 1h TTL；
- fake clock；
- Lifecycle Reaper；
- checkpoint；
- unload；
- restore；
- `restored_from_runtime_instance_id`。

## 规则

- L1 有活动 L2 时不得卸载；
- 持久化失败时不得标记 `UNLOADED`；
- 完整 Transcript 不自动重新注入模型；
- 恢复加载 Session Summary、Memory、Trace 索引和未完成 TaskState；
- Memory 查询必须强制 `tenant_id + biz_domain`。

## 必测

- L2 TTL 边界；
- L1 TTL 边界；
- active L2 阻止 L1 卸载；
- 三个 scope 的 Memory canary 不交叉；
- 恢复后 logical ID 不变、runtime ID 变化；
- Session Summary 和 Memory 可恢复；
- 已完成 Demo Tool 写入不重复执行。

---

# Phase 6：云端部署和最终验证

## 目标

使用本地 `config.txt` 在干净云服务器上部署最新稳定版 OpenClaw、AgentNest 和 PostgreSQL，并生成清晰的 Demo 验证结果。

## 必须交付

```text
scripts/deploy/preflight.sh
scripts/deploy/install-openclaw.sh
scripts/deploy/deploy.sh
scripts/deploy/status.sh
scripts/verify/run-all.sh
scripts/verify/run-isolation.sh
scripts/verify/run-lifecycle.sh
scripts/verify/run-recovery.sh
```

Docker Compose 最少包含：

```text
postgres
control-plane
data-gateway-mock
external-gateway-mock
```

OpenClaw 可以使用官方推荐 daemon 或容器，选择最小可靠方案并在 README 记录。

## 最终命令

```bash
pnpm demo:preflight
pnpm demo:deploy
pnpm demo:status
pnpm demo:verify
```

## 远端规则

- `config.txt` 只读且禁止回显；
- 只操作 `REMOTE_WORKDIR` 和本项目容器；
- PostgreSQL、OpenClaw、Admin API 默认 loopback/私网；
- 脚本支持重复执行；
- 结果明确区分真实 OpenClaw 行为与 Mock Tool 行为。

---

# 明确不做

第一版不实现：

```text
Capability Token/JWT/PASETO
nonce/revoke/rotation
Redis
MinIO
Kafka/Outbox
分布式锁/多节点 HA
向量数据库
审计 hash chain
OAuth/完整 RBAC
Kubernetes
生产计费和配额
全面故障注入与性能压测
```

这些内容只能写入“后续生产化建议”，不能阻塞 Demo。

---

# 完成定义

只有同时满足以下条件才算完成：

1. 至少一条真实 OpenClaw L0 → L1 → L2 → Mock Tool 链路运行成功；
2. 三个 tenant/biz scope 的 Profile、Skill、Tool、Memory、Session 隔离测试通过；
3. L2 权限子集测试通过；
4. L1/L2 TTL、持久化、卸载和恢复测试通过；
5. 云服务器可重复部署；
6. `pnpm demo:verify` 退出码为 0；
7. 没有提交任何机密；
8. README 记录 OpenClaw stable 版本、实现限制和验证结果。
