# AgentNest 接口与领域契约

本文定义 Demo 必须遵守的外部 API、内部接口、状态机和关键数据结构。具体字段以后可以向后兼容地扩展，但不得删除租户隔离和审计字段。

---

## 1. 通用规则

### 1.1 必须字段

所有写请求：

```text
request_id
idempotency_key
tenant_id
biz_domain
user_id
task/resource context
```

所有响应：

```text
success
code
message
request_id
trace_id
data/error
```

所有内部事件：

```text
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
agent_id
session_id
task_id
trace_id
capability_snapshot_id
timestamp
```

### 1.2 可信与不可信上下文

以下字段来自调用方，只是声明，不能直接作为授权事实：

```text
tenant_id
biz_domain
user_id
role
resource_id
```

Control Plane 必须通过认证上下文或 Demo 固定身份映射解析可信身份。向 OpenClaw 和 Gateway 传递时，使用由 Control Plane 签发的 Capability Token。

### 1.3 错误处理

- 授权失败返回统一业务错误，不暴露其他租户是否存在；
- 任何未知 capability/tool/action 默认拒绝；
- 业务错误可以 HTTP 4xx；系统错误使用 5xx；
- Tool 协议若要求 HTTP 200 包裹错误，内部 `success=false` 和 `code` 仍必须可靠；
- 所有拒绝写 Trace 和 Audit，但不得记录密钥或完整敏感输入。

---

# 2. 对外任务接口

## 2.1 提交任务

```http
POST /api/v1/tasks
Content-Type: application/json
Authorization: Bearer <demo-api-token>
Idempotency-Key: <idempotency-key>
```

请求：

```json
{
  "request_id": "req_01J...",
  "idempotency_key": "tenant-a-legal-case-001-check-v1",
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "user_id": "user_001",
  "role": "lawyer",
  "task_type": "LEGAL_EVIDENCE_CHECK",
  "resource": {
    "resource_type": "CASE",
    "resource_id": "case_001"
  },
  "input": {
    "question": "检查现有材料是否形成完整证据链"
  },
  "execution": {
    "async": true,
    "model": null,
    "thinking": null
  }
}
```

响应：

```json
{
  "success": true,
  "code": "TASK_ACCEPTED",
  "message": "task accepted",
  "request_id": "req_01J...",
  "trace_id": "tr_01J...",
  "data": {
    "task_id": "task_01J...",
    "logical_agent_id": "tb_34f5...",
    "runtime_instance_id": "ari_01J...",
    "status": "QUEUED"
  },
  "error": null
}
```

### 幂等语义

相同：

```text
tenant_id + biz_domain + idempotency_key
```

必须返回相同 `task_id`，不能创建第二个任务或重复 Tool 副作用。

---

## 2.2 查询任务

```http
GET /api/v1/tasks/{task_id}
```

响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "task found",
  "request_id": "req_lookup_01",
  "trace_id": "tr_01J...",
  "data": {
    "task_id": "task_01J...",
    "tenant_id": "tenant_A",
    "biz_domain": "LEGAL",
    "task_type": "LEGAL_EVIDENCE_CHECK",
    "status": "COMPLETED",
    "logical_agent_id": "tb_34f5...",
    "runtime_instance_id": "ari_01J...",
    "l2_session_id": "session_01J...",
    "current_step": "FINALIZED",
    "result": {
      "summary": "demo result",
      "artifact_refs": []
    },
    "created_at": "2026-07-11T10:00:00Z",
    "updated_at": "2026-07-11T10:00:10Z"
  },
  "error": null
}
```

查询必须结合认证中的 tenant/biz；不能只按 `task_id` 返回其他租户任务。

---

# 3. Agent 查询与管理接口

## 3.1 查询逻辑 Agent

```http
GET /api/v1/agents/{logical_agent_id}
```

响应必须包含：

```json
{
  "logical_agent_id": "tb_34f5...",
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "status": "ACTIVE",
  "current_runtime_instance_id": "ari_01J...",
  "capability_snapshot_id": "caps_01J...",
  "active_l2_count": 0,
  "last_active_at": "2026-07-11T10:00:10Z"
}
```

不得返回 Capability Token、模型密钥或完整 Memory。

## 3.2 强制 checkpoint

```http
POST /api/v1/admin/agents/{logical_agent_id}/checkpoint
Authorization: Bearer <admin-token>
```

请求：

```json
{
  "request_id": "req_admin_01",
  "reason": "demo-verification"
}
```

## 3.3 强制卸载

```http
POST /api/v1/admin/agents/{logical_agent_id}/unload
```

请求：

```json
{
  "request_id": "req_admin_02",
  "reason": "demo-verification",
  "force": false
}
```

`force=false` 是默认值。存在活动子任务或 checkpoint 失败时必须拒绝。Demo 不需要实现绕过持久化的强制删除。

## 3.4 Reaper 单次运行

```http
POST /api/v1/admin/reaper/run-once
```

返回：

```json
{
  "scanned": 10,
  "l1_candidates": 2,
  "l1_unloaded": 1,
  "l2_candidates": 3,
  "l2_archived": 3,
  "skipped_active": 1,
  "failed": 0
}
```

## 3.5 测试时钟

仅 `NODE_ENV=test|demo` 且 Admin API 绑定 loopback 时开放：

```http
POST /api/v1/admin/test-clock/advance
```

```json
{
  "seconds": 90000
}
```

生产 profile 必须返回 `404` 或 `FEATURE_DISABLED`。

---

# 4. 健康与指标

```http
GET /health/live
GET /health/ready
GET /metrics
```

Readiness 至少检查：

- PostgreSQL；
- Redis；
- MinIO；
- OpenClaw Gateway；
- OpenClaw 配置是否包含有效 Main Agent；
- Capability signing key 是否可用；
- migration 是否完成。

不得在健康响应中输出连接串或凭证。

---

# 5. 内部 OpenClaw Adapter 契约

```ts
interface OpenClawAgentProfileSpec {
  agentId: string;
  logicalAgentId: string;
  tenantId: string;
  bizDomain: string;
  workspace: string;
  agentDir: string;
  skills: readonly string[];
  tools: {
    allow: readonly string[];
    deny: readonly string[];
  };
  sandbox: {
    mode: "all";
    scope: "agent";
  };
  subagents: {
    maxChildrenPerAgent: number;
    runTimeoutSeconds: number;
    archiveAfterMinutes: number;
  };
  capabilitySnapshotId: string;
}

interface OpenClawConfigAdapter {
  ensureProfile(spec: OpenClawAgentProfileSpec): Promise<EnsureProfileResult>;
  deactivateProfile(agentId: string): Promise<void>;
  inspectProfile(agentId: string): Promise<ObservedProfile | null>;
  dispatchToAgent(input: DispatchInput): Promise<DispatchResult>;
  archiveSession(input: ArchiveSessionInput): Promise<ArchiveSessionResult>;
}
```

要求：

- 写配置前读取并校验 current revision；
- 使用官方 Config RPC 或安全的结构化 JSON 修改；
- 禁止 grep/sed 字符串替换 JSON；
- 更新后验证实际 observed profile；
- 配置热加载失败不得把数据库状态标记为 ACTIVE。

---

# 6. Capability Snapshot 契约

```json
{
  "snapshot_id": "caps_01J...",
  "schema_version": "1.0",
  "policy_version": 12,
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "skills": [
    {
      "name": "legal-evidence-check",
      "version": "1.0.0",
      "content_hash": "sha256:..."
    }
  ],
  "tools": [
    {
      "name": "legal.case.read",
      "actions": ["read"],
      "constraints": {
        "resource_types": ["CASE"]
      }
    }
  ],
  "memory_scopes": [
    {
      "type": "CASE_MEMORY",
      "resource_type": "CASE",
      "access": ["read", "write"]
    }
  ],
  "data_scopes": [
    {
      "resource_type": "CASE",
      "operations": ["read", "analysis.write"]
    }
  ],
  "sandbox_policy": {
    "mode": "all",
    "scope": "agent",
    "exec_allowed": false
  },
  "lifecycle_policy": {
    "l1_idle_ttl_seconds": 86400,
    "l2_idle_ttl_seconds": 3600,
    "max_active_l2": 5
  },
  "created_at": "2026-07-11T10:00:00Z",
  "hash": "sha256:..."
}
```

Snapshot 创建后不可修改。策略变化创建新 Snapshot。

---

# 7. Capability Token 契约

Token payload：

```json
{
  "iss": "agentnest-control-plane",
  "aud": ["data-gateway", "external-gateway"],
  "jti": "captok_01J...",
  "parent_jti": null,
  "snapshot_id": "caps_01J...",
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "logical_agent_id": "tb_34f5...",
  "runtime_instance_id": "ari_01J...",
  "agent_id": "tb_34f5...",
  "session_id": "session_01J...",
  "task_id": "task_01J...",
  "tools": {
    "legal.case.read": ["read"]
  },
  "memory_scope": {
    "resource_type": "CASE",
    "resource_ids": ["case_001"]
  },
  "data_scope": {
    "resource_type": "CASE",
    "resource_ids": ["case_001"]
  },
  "iat": 1783764000,
  "exp": 1783767600,
  "nonce": "..."
}
```

Token 不能包含密码、模型 key 或数据库凭证。

---

# 8. Gateway Tool 调用契约

```http
POST /tools/execute
Authorization: Capability <signed-token>
```

请求：

```json
{
  "request_id": "req_tool_01",
  "trace_id": "tr_01J...",
  "tool_call_id": "tc_01J...",
  "tool_name": "legal.case.read",
  "action": "read",
  "params": {
    "case_id": "case_001"
  }
}
```

Gateway 必须从 Token 解析可信上下文，不能使用 body 覆盖：

```text
tenant_id
biz_domain
agent_id
session_id
task_id
resource scope
```

成功响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "tool executed",
  "request_id": "req_tool_01",
  "trace_id": "tr_01J...",
  "data": {
    "case_id": "case_001",
    "demo_materials": ["contract.txt", "transfer.txt"]
  },
  "audit_id": "audit_01J...",
  "error": null
}
```

拒绝响应：

```json
{
  "success": false,
  "code": "CAPABILITY_DENIED",
  "message": "tool action is not allowed",
  "request_id": "req_tool_01",
  "trace_id": "tr_01J...",
  "data": null,
  "audit_id": "audit_01J...",
  "error": {
    "category": "AUTHORIZATION",
    "retryable": false
  }
}
```

---

# 9. Agent 状态机

## 9.1 L1 Runtime

```text
PROVISIONING
  → ACTIVE
  → IDLE
  → CHECKPOINTING
  → UNLOADING
  → DESTROYED
```

异常：

```text
PROVISIONING → FAILED
CHECKPOINTING → CHECKPOINT_FAILED → ACTIVE/IDLE
UNLOADING → UNLOAD_FAILED → IDLE
```

禁止直接：

```text
ACTIVE → DESTROYED
RUNNING_CHILDREN → UNLOADING
CHECKPOINT_FAILED → DESTROYED
```

## 9.2 L2 Task

```text
QUEUED
  → SPAWNING
  → RUNNING
  → WAITING_TOOL | WAITING_INPUT
  → COMPLETED | FAILED | CANCELLED
  → CHECKPOINTED
  → ARCHIVED
```

`WAITING_INPUT` 应 checkpoint 并允许卸载运行态。

---

# 10. 持久化 Repository 契约

所有读取都必须显式传入 scope：

```ts
interface TenantBizScope {
  tenantId: string;
  bizDomain: string;
}

interface TaskRepository {
  findById(scope: TenantBizScope, taskId: string): Promise<TaskRecord | null>;
  create(scope: TenantBizScope, input: CreateTaskInput): Promise<TaskRecord>;
  checkpoint(scope: TenantBizScope, input: TaskCheckpoint): Promise<void>;
}
```

禁止出现：

```ts
findById(taskId: string)
findMemory(resourceId: string)
findSession(sessionId: string)
```

除非函数仅供内部使用且调用前已经绑定不可变 Scope，且有静态/测试证明。

---

# 11. Trace 事件类型

至少支持：

```text
REQUEST_ACCEPTED
L1_ENSURE_STARTED
L1_PROFILE_CREATED
L1_PROFILE_REUSED
L1_RESTORED
L2_SPAWN_REQUESTED
L2_SPAWNED
SKILL_SELECTED
TOOL_CALL_REQUESTED
TOOL_CALL_ALLOWED
TOOL_CALL_DENIED
TOOL_CALL_COMPLETED
MEMORY_READ
MEMORY_WRITE
CHECKPOINT_STARTED
CHECKPOINT_COMPLETED
CHECKPOINT_FAILED
L2_ARCHIVED
L1_UNLOAD_STARTED
L1_UNLOADED
RESTORE_STARTED
RESTORE_COMPLETED
POLICY_CHANGED
TOKEN_ISSUED
TOKEN_REJECTED
```

Trace payload 必须脱敏并带 schema version。

---

# 12. Demo 种子能力

## tenant_A + LEGAL

允许：

```text
Skill: legal-evidence-check
Tool: legal.case.read/read
Tool: legal.analysis.write/write
External: legal.research.query/query
```

## tenant_A + ROBOT_DOG

允许：

```text
Skill: robot-dog-health-check
Tool: robot.device.read/read
Tool: robot.health.write/write
External: robot.telemetry.enrich/query
```

## tenant_B + LEGAL

允许与 tenant_A + LEGAL 相同的定义，但数据、Memory、Session、Agent Profile 必须完全隔离。
