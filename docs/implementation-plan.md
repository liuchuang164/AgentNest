# AgentNest Demo 实现蓝图

本文件给 Codex 提供代码级模块划分。阶段顺序以 `CODEX_TASK.md` 为准。

原则：先让真实 OpenClaw 三层链路跑通，再实现最小隔离、生命周期和恢复。不要提前建设生产安全平台。

---

## 1. Monorepo 结构

```text
apps/
  control-plane/
    src/
      api/
      domain/
      application/
      infrastructure/
      workers/
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

第一版不创建 Redis、MinIO、Kafka 或 Capability Token 包。

---

## 2. `apps/control-plane`

### `domain`

纯领域对象：

```text
LogicalAgent
RuntimeInstance
TaskState
TenantCapabilityProfile
TaskTemplate
ExecutionContext
LifecyclePolicy
Agent/Task state machine
Capability intersection
ID derivation
```

禁止依赖 HTTP、数据库 Client 或 OpenClaw CLI。

### `application`

用例：

```text
SubmitTask
EnsureTenantBizAgent
DispatchTask
SpawnTaskAgent
ResolveTenantCapabilities
CreateExecutionContext
CheckpointAgent
UnloadAgent
RestoreAgent
RunReaperOnce
```

### `infrastructure`

```text
PostgreSQL repositories
OpenClaw adapter
Persistent file store
System/Fake Clock
Structured logger
```

### `api`

- Fastify routes；
- Schema validation；
- error mapping；
- OpenAPI；
- 不放核心业务逻辑。

### `workers`

- Lifecycle Reaper；
- stale task recovery；
- OpenClaw observed-state reconciliation（最小实现）。

不实现 Outbox publisher、leader election 或分布式调度。

---

## 3. `packages/contracts`

使用一套运行时 Schema 生成 TypeScript 类型和 OpenAPI/JSON Schema。

至少包含：

```text
TaskRequest/Response
AgentStatus
TaskStatus
TenantCapabilityProfile
ExecutionContext
ToolExecuteRequest/Response
TraceEvent
CheckpointRecord
```

不包含 Capability Token Claims。

---

## 4. 能力配置

能力模块可以直接放在 control-plane domain/application 中，也可以做轻量 package。

建议文件：

```text
capability/catalog.ts
capability/profile.ts
capability/resolver.ts
capability/intersection.ts
capability/task-template.ts
capability/errors.ts
```

关键 API：

```ts
resolveTenantBizProfile(scope): Promise<TenantCapabilityProfile>
intersectForTask(parent, template): EffectiveTaskCapability
assertSubset(child, parent): void
```

只处理：

- Skill 名称；
- Tool 名称和 action；
- Memory Scope；
- 生命周期参数。

不处理签名、nonce、revoke、issuer/audience 或通用 Policy DSL。

---

## 5. `packages/openclaw-adapter`

职责：

- 检查 OpenClaw stable 版本；
- 创建/更新/停用 L1 Profile；
- 检查 observed Profile；
- 向 L0/L1 dispatch；
- 调用 `sessions_spawn` 创建 L2；
- 查询和归档 Session；
- 健康检查。

实现优先级：

1. 官方 Config API/RPC；
2. 官方 CLI 非交互命令；
3. 结构化 JSON 配置更新和 reload；
4. 若 stable 确实限制动态 Profile，使用有限模板或受控多实例方案。

禁止：

- sed/regex 直接改 JSON；
- 把不同 L1 指向同一 agentDir；
- 用 beta 版本绕过实现困难；
- 第一版 fork OpenClaw 核心。

---

## 6. `packages/tenant-runtime-plugin`

职责保持最小：

- 从 Agent/Session 解析 `execution_context_id`；
- 根据当前 L1/L2 能力过滤 Tool Definition；
- Tool 执行前检查当前视图是否包含 tool/action；
- 将 `execution_context_id` 和调用参数发送给 Gateway Mock；
- 返回标准 ToolResult；
- 写 Trace hook。

禁止：

- 自行决定 tenant/biz；
- 从 Plugin 静态配置读取一个固定 tenant 作为所有请求身份；
- 直接访问 Demo 业务表；
- 在 Plugin 内实现 JWT、PKI 或完整授权服务。

---

## 7. Execution Context

Control Plane 为每个 L2 创建 PostgreSQL 记录：

```text
execution_context_id UUID
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

Gateway 通过 ID 读取该记录并校验调用。

建议 API：

```ts
createExecutionContext(input): Promise<ExecutionContext>
getExecutionContext(id): Promise<ExecutionContext | null>
assertToolAllowed(context, toolName, action): void
assertResourceAllowed(context, resource): void
```

---

## 8. Gateway Mock

两套 Gateway 共用轻量执行流程：

```text
validate request schema
load execution context
check expiry
check tool/action
check resource scope
execute deterministic handler
write ALLOW/DENY trace
return response
```

Mock Handler 必须产生可查询副作用，例如在 PostgreSQL 写分析结果，才能验证越权请求没有副作用。

不实现：

- JWT 验签；
- Token revoke/replay；
- 限流/计费；
- 熔断/复杂重试；
- 任意 URL fetch。

---

## 9. Demo Skill

### LEGAL

输入：`case_id`。

步骤：

1. 调 `legal_case_read/read`；
2. 执行确定性材料检查；
3. 调 `legal_analysis_write/write`；
4. 返回结构化结果。

### ROBOT_DOG

输入：`device_id`。

步骤：

1. 调 `robot_device_read/read`；
2. 执行确定性健康判断；
3. 调 `robot_health_write/write`；
4. 返回结构化结果。

Skill 业务逻辑保持简单，重点验证 Agent 层级和隔离。

---

## 10. PostgreSQL 迁移

建议：

```text
001_tenant_business.sql
002_tenant_capability_profile.sql
003_logical_agent.sql
004_runtime_instance.sql
005_task.sql
006_execution_context.sql
007_session_summary.sql
008_memory.sql
009_trace.sql
010_demo_resources.sql
011_demo_results.sql
```

业务和状态表必须有 tenant+biz 索引。

---

## 11. Runtime Registry

Control Plane 可以使用：

```ts
Map<logicalAgentId, ActiveRuntime>
```

缓存活跃 L1/L2 对象。

要求：

- Map 只是可重建 cache；
- logical agent、runtime instance、task 和 checkpoint 状态保存在 PostgreSQL；
- Control Plane 重启后可以从数据库恢复逻辑状态；
- 单节点 Demo 使用进程互斥或 PostgreSQL 行锁防止重复 ensure。

不实现 Redis 心跳和多节点分布式锁。

---

## 12. Transcript 与 checkpoint 文件

```text
runtime/persistence/<logical_agent_id>/
  sessions/<session_id>.jsonl
  sessions/<session_id>.summary.json
  tasks/<task_id>.checkpoint.json
  tasks/<task_id>.result.json
```

路径由服务端逻辑 ID 派生并做根目录检查。

不要求 MinIO、对象 hash、加密 metadata 或对象访问网关。

---

## 13. 日志与 Trace

结构化日志建议字段：

```text
service
level
event
request_id
trace_id
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
code
latency_ms
```

日志不得记录密码、模型 Key、私钥或完整连接串。

Trace 只需要支持：

```text
AGENT_CREATED
AGENT_REUSED
L2_SPAWNED
TOOL_ALLOWED
TOOL_DENIED
CHECKPOINT_COMPLETED
AGENT_UNLOADED
AGENT_RESTORED
TASK_COMPLETED
TASK_FAILED
```

不实现 hash chain 或外部审计平台。

---

## 14. 测试组织

```text
*.unit.test.ts          纯逻辑
*.integration.test.ts   PostgreSQL + Gateway Mock
tests/e2e               真实 OpenClaw 三层链路
tests/isolation         Skill/Tool/Memory/Session 隔离
tests/lifecycle         fake clock、unload、restore
```

第一版不要求 Redis/MinIO/Testcontainers 故障矩阵和大规模 resilience suite。

---

## 15. 推荐实现顺序

1. 工程骨架与 Schema；
2. Capability Profile 与交集；
3. PostgreSQL Repository；
4. L1 Runtime Registry；
5. OpenClaw Adapter；
6. L0/L1 Profile；
7. L2 `sessions_spawn`；
8. Execution Context 与 Gateway Mock；
9. Demo Skill；
10. Memory/Trace/Session Summary；
11. Lifecycle/Reaper/Restore；
12. 云端部署与验证。

不要先写 UI，也不要先实现生产安全基础设施。
