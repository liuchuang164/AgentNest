# 实现蓝图

本文件给 Codex 提供代码级模块划分。阶段顺序以 `CODEX_TASK.md` 为准，本文件解释每个包应该放什么、禁止放什么。

---

## 1. Monorepo 结构

```text
apps/
  control-plane/
    src/
      api/
      application/
      domain/
      infrastructure/
      workers/
  data-gateway-mock/
  external-gateway-mock/

packages/
  contracts/
  capability/
  persistence/
  openclaw-adapter/
  tenant-runtime-plugin/
  test-support/

skills/
  legal-evidence-check/
    SKILL.md
    manifest.json
  robot-dog-health-check/
    SKILL.md
    manifest.json

infra/
  docker-compose.yml
  postgres/migrations/
  minio/
  openclaw/templates/

scripts/
  deploy/
  verify/
  dev/

tests/
  e2e/
  security/
  lifecycle/
  resilience/
```

---

## 2. control-plane 分层

### domain

只包含纯领域逻辑：

```text
LogicalAgent
RuntimeInstance
TaskState
CapabilitySnapshot
CapabilityGrant
LifecyclePolicy
Agent/Task state machine
Capability intersection
ID derivation
```

禁止：HTTP、数据库 Client、OpenClaw API、环境变量。

### application

用例：

```text
SubmitTask
EnsureTenantBizAgent
DispatchTask
SpawnTaskAgent
CheckpointAgent
UnloadAgent
RestoreAgent
RunReaperOnce
ResolveCapabilities
IssueCapabilityToken
```

### infrastructure

实现端口：

```text
Postgres repositories
Redis lock/heartbeat
MinIO blob store
OpenClaw adapter
JWT/JWS signer
Clock
Metrics
```

### api

- Fastify routes；
- Schema validation；
- Auth context；
- error mapping；
- OpenAPI registration；
- 不承载领域逻辑。

### workers

- Lifecycle Reaper；
- Outbox publisher；
- OpenClaw reconciliation；
- stale task recovery。

---

## 3. packages/contracts

单一契约来源：

- TypeBox/Zod 等运行时 Schema；
- 从同一来源导出 TypeScript 类型；
- 生成 JSON Schema/OpenAPI；
- 禁止手写三套容易漂移的类型。

至少包含：

```text
TaskRequest/Response
AgentStatus
TaskStatus
CapabilitySnapshot
CapabilityTokenClaims
ToolExecuteRequest/Response
TraceEvent
CheckpointRecord
DeploymentManifest
TestSummary
```

---

## 4. packages/capability

模块：

```text
catalog.ts
resolver.ts
intersection.ts
snapshot.ts
token.ts
policy-diff.ts
errors.ts
```

关键 API：

```ts
resolveTenantBizCapabilities(scope): Promise<ResolvedCapabilities>
createSnapshot(resolved): CapabilitySnapshot
intersectForTask(parent, template, current): EffectiveTaskCapability
assertSubset(child, parent): void
issueToken(context): Promise<string>
verifyToken(token, expectedContext): Promise<VerifiedCapability>
```

交集必须以 tool action、resource scope、memory access 和 TTL 为粒度。

---

## 5. packages/openclaw-adapter

职责：

- 安装版本检查；
- 获取 config schema；
- 结构化修改 OpenClaw config；
- Profile ensure/deactivate；
- observed state 验证；
- dispatch；
- Session inspect/archive；
- Gateway health。

优先级：

1. 官方 Config RPC；
2. 官方 CLI 非交互命令；
3. 带 revision/CAS 的结构化 JSON 文件写入；
4. 禁止 sed/regex 修改 JSON。

所有外部命令：

- 参数数组调用，不拼 shell 字符串；
- timeout；
- stdout/stderr 脱敏；
- exit code 检查；
- 记录命令名但不记录密钥。

---

## 6. packages/tenant-runtime-plugin

这是 OpenClaw 插件，职责仅限：

- 从 agent/session context 解析 `runtime_instance_id`；
- 从 Control Plane 获取或缓存当前 Capability Context；
- 过滤 Tool definitions；
- Tool 执行前 action 检查；
- 注入 Capability Token；
- 调用 Data/External Gateway；
- 生成标准 ToolResult；
- 写 Trace hook。

禁止：

- 自己决定 tenant；
- 用 plugin 静态 `tenantId` 作为生产身份；
- 持有数据库或 MinIO 管理凭证；
- 绕过 Gateway 直接访问真实数据；
- 在本地缓存长期 Memory。

缓存 key 必须至少包含：

```text
runtime_instance_id + session_id + capability_snapshot_id
```

策略变化或 Token 过期必须失效。

---

## 7. Gateway Mock

两套 Gateway 共用安全中间件：

```text
parse token
verify signature/audience/expiry
bind request to token context
check tool/action
check resource scope
check idempotency/replay
execute deterministic handler
write audit + trace
return standard response
```

Mock Handler 必须真的产生可检查副作用，例如写数据库记录；不能只返回预制 JSON，否则无法验证越权未造成副作用。

---

## 8. Skill 设计

### LEGAL Skill

输入：`case_id`。

步骤：

1. 调 `legal.case.read/read`；
2. 对 Demo 材料做确定性检查；
3. 调 `legal.analysis.write/write`；
4. 返回结构化结果。

### ROBOT_DOG Skill

输入：`device_id`。

步骤：

1. 调 `robot.device.read/read`；
2. 对 Demo 指标做确定性健康判断；
3. 调 `robot.health.write/write`；
4. 返回结构化结果。

Skill 业务逻辑保持简单，重点是 Tool 和租户隔离。

每个 Skill manifest：

```json
{
  "name": "legal-evidence-check",
  "version": "1.0.0",
  "required_tools": {
    "legal.case.read": ["read"],
    "legal.analysis.write": ["write"]
  }
}
```

---

## 9. 配置生成

不能直接让模型编辑完整 `openclaw.json`。

流程：

1. Control Plane 生成 `OpenClawAgentProfileSpec`；
2. Adapter 读取当前配置和 revision；
3. 合并/替换指定 `agents.list[]` 项；
4. 通过 OpenClaw Schema 校验；
5. 原子写入/Config RPC；
6. 等待 hot reload；
7. 读取 observed profile；
8. 比较 workspace、agentDir、skills、tools、sandbox；
9. 一致后才提交 ACTIVE 状态。

同一逻辑 L1 并发 ensure 必须只有一个写入者。

---

## 10. 数据库迁移顺序

建议：

```text
001_tenant_business.sql
002_capability_catalog.sql
003_capability_binding.sql
004_capability_snapshot.sql
005_logical_agent.sql
006_runtime_instance.sql
007_task_state.sql
008_session_snapshot.sql
009_memory.sql
010_trace_event.sql
011_tool_audit.sql
012_idempotency.sql
013_outbox.sql
014_demo_resources.sql
```

所有业务表主键之外应有 tenant+biz 索引。

---

## 11. 可观测性

结构化日志字段：

```text
service
level
event
request_id
trace_id
tenant_id_hash
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
code
latency_ms
```

默认不要在日志明文输出 tenant 原始名称，可使用 hash/内部 ID。

指标：

```text
agentnest_l1_active
agentnest_l2_active
agentnest_task_total{status}
agentnest_tool_call_total{decision,tool}
agentnest_reaper_total{result,level}
agentnest_checkpoint_duration_seconds
agentnest_restore_duration_seconds
agentnest_capability_denied_total{reason}
agentnest_openclaw_config_reload_total{result}
```

---

## 12. 测试组织

```text
*.unit.test.ts       纯逻辑
*.integration.test.ts 真实 PG/Redis/MinIO
*.contract.test.ts   Schema/API
tests/e2e            OpenClaw 三层链路
tests/security       越权和副作用
tests/lifecycle      fake clock/Reaper
tests/resilience     重启与依赖故障
```

所有 E2E 生成唯一 run namespace，避免并发污染。

---

## 13. 推荐实现顺序

1. 领域状态和 Schema；
2. Capability intersection/token；
3. Persistence；
4. Gateway Mock；
5. Lifecycle/Reaper；
6. OpenClaw Adapter；
7. Tenant Plugin；
8. L1 Profile 创建；
9. L2 spawn；
10. Skill Demo；
11. Recovery；
12. 远端部署与报告。

不要先写完整 UI。最早期通过 API、OpenClaw CLI 和测试报告验证。
