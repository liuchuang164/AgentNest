# AgentNest Demo 接口与领域契约

## 1. 通用规则

所有业务请求必须包含：

```text
request_id
tenant_id
biz_domain
task_type
```

所有响应至少包含：

```text
success
code
message
request_id
trace_id
data 或 error
```

所有 Agent、Task、Memory、Trace 记录必须可关联：

```text
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
trace_id
```

调用方 body 中的 `tenant_id`、`biz_domain` 是路由声明。Control Plane 校验后，将权威 scope 写入服务端 `execution_context`。Gateway Mock 不直接相信模型或 Tool body 自报的 scope。

---

## 2. 提交任务

```http
POST /api/tasks
Content-Type: application/json
```

请求：

```json
{
  "request_id": "req_001",
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "user_id": "user_001",
  "task_type": "LEGAL_EVIDENCE_CHECK",
  "resource": {
    "resource_type": "CASE",
    "resource_id": "case_001"
  },
  "input": {
    "question": "检查材料是否形成证据链"
  }
}
```

响应：

```json
{
  "success": true,
  "code": "TASK_ACCEPTED",
  "message": "task accepted",
  "request_id": "req_001",
  "trace_id": "trace_001",
  "data": {
    "task_id": "task_001",
    "logical_agent_id": "tb_1234",
    "runtime_instance_id": "runtime_001",
    "l2_agent_id": "l2_001",
    "status": "RUNNING"
  },
  "error": null
}
```

Demo 可以用 `request_id` 或可选 `idempotency_key` 防止同一请求重复创建任务，但不要求通用幂等平台。

---

## 3. 查询任务

```http
GET /api/tasks/{task_id}
```

响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "task found",
  "request_id": "req_lookup_001",
  "trace_id": "trace_001",
  "data": {
    "task_id": "task_001",
    "tenant_id": "tenant_A",
    "biz_domain": "LEGAL",
    "task_type": "LEGAL_EVIDENCE_CHECK",
    "status": "COMPLETED",
    "logical_agent_id": "tb_1234",
    "runtime_instance_id": "runtime_001",
    "l2_session_id": "session_001",
    "result": {
      "summary": "demo result"
    }
  },
  "error": null
}
```

Repository 查询必须同时携带调用方已经解析出的 `tenant_id + biz_domain`，不能只按 `task_id` 返回数据。

---

## 4. Agent 接口

### 4.1 活跃 Agent 列表

```http
GET /api/agents
```

### 4.2 Agent 详情

```http
GET /api/agents/{logical_agent_id}
```

返回至少包含：

```json
{
  "logical_agent_id": "tb_1234",
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "status": "ACTIVE",
  "current_runtime_instance_id": "runtime_001",
  "active_l2_count": 0,
  "skills": ["legal-evidence-check"],
  "tools": {
    "legal_case_read": ["read"],
    "legal_analysis_write": ["write"]
  },
  "last_active_at": "2030-01-01T00:00:00Z"
}
```

### 4.3 Agent Memory

```http
GET /api/agents/{logical_agent_id}/memories
```

只返回当前 Agent scope 的 Demo Memory，不返回其他 tenant/biz。

---

## 5. Admin / Demo 接口

仅在 `NODE_ENV=test|demo` 且绑定 loopback/私网时开放。

### 5.1 运行 Reaper

```http
POST /api/admin/reaper/run
```

返回：

```json
{
  "l1_scanned": 3,
  "l1_unloaded": 1,
  "l2_scanned": 4,
  "l2_unloaded": 2,
  "skipped_active": 1,
  "failed": 0
}
```

### 5.2 推进测试时钟

```http
POST /api/admin/clock/advance
```

请求：

```json
{
  "seconds": 3600
}
```

### 5.3 手动 checkpoint / unload

```http
POST /api/admin/agents/{logical_agent_id}/checkpoint
POST /api/admin/agents/{logical_agent_id}/unload
```

存在活动 L2 或持久化失败时，unload 必须拒绝。

---

## 6. 健康检查

```http
GET /health
```

至少检查：

- PostgreSQL；
- OpenClaw Gateway；
- Main Agent 配置存在；
- migration 已完成。

健康响应不得输出凭证或连接串。

---

## 7. OpenClaw Adapter 契约

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
    deny?: readonly string[];
  };
  subagents: {
    maxChildrenPerAgent: number;
    runTimeoutSeconds: number;
    archiveAfterMinutes: number;
  };
}

interface OpenClawAdapter {
  ensureProfile(spec: OpenClawAgentProfileSpec): Promise<void>;
  deactivateProfile(agentId: string): Promise<void>;
  inspectProfile(agentId: string): Promise<unknown | null>;
  dispatchToAgent(input: unknown): Promise<unknown>;
  spawnTaskAgent(input: unknown): Promise<unknown>;
  archiveSession(input: unknown): Promise<void>;
}
```

要求：

- 使用 OpenClaw stable 公开接口、CLI 或结构化配置；
- 不用 grep/sed 修改 JSON；
- 更新后检查实际 observed profile；
- 配置失败时不把运行实例标记为 ACTIVE。

---

## 8. Capability Profile

Demo 使用简单版本化 Profile，不使用签名 Snapshot/Token。

```json
{
  "profile_id": "cap_001",
  "version": 1,
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "skills": ["legal-evidence-check"],
  "tools": {
    "legal_case_read": ["read"],
    "legal_analysis_write": ["write"],
    "legal_research_query": ["query"]
  },
  "memory_scopes": ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
  "lifecycle": {
    "l1_idle_ttl_seconds": 86400,
    "l2_idle_ttl_seconds": 3600,
    "max_active_l2": 5
  },
  "created_at": "2030-01-01T00:00:00Z"
}
```

L2 Profile 由 L1 Profile 与 Task Template 取交集。

---

## 9. Execution Context

Control Plane 为每个 L2 创建服务端记录：

```json
{
  "execution_context_id": "0f7e6c1a-9e75-45da-bae7-1d6235f8fd94",
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "logical_agent_id": "tb_1234",
  "runtime_instance_id": "runtime_001",
  "session_id": "session_001",
  "task_id": "task_001",
  "allowed_skills": ["legal-evidence-check"],
  "allowed_tools": {
    "legal_case_read": ["read"],
    "legal_analysis_write": ["write"]
  },
  "resource_scope": {
    "resource_type": "CASE",
    "resource_ids": ["case_001"]
  },
  "expires_at": "2030-01-01T01:00:00Z"
}
```

约束：

- ID 使用随机 UUID；
- 记录保存在 PostgreSQL；
- Gateway 根据 ID 读取权威内容；
- body 不能覆盖 tenant/biz/allowed tools；
- context 不存在、过期或 scope 不匹配时拒绝。

---

## 10. Tool Gateway Mock 契约

请求：

```json
{
  "request_id": "tool_req_001",
  "trace_id": "trace_001",
  "execution_context_id": "0f7e6c1a-9e75-45da-bae7-1d6235f8fd94",
  "tool_name": "legal_case_read",
  "action": "read",
  "resource": {
    "resource_type": "CASE",
    "resource_id": "case_001"
  },
  "params": {}
}
```

成功响应：

```json
{
  "success": true,
  "code": "OK",
  "message": "tool executed",
  "request_id": "tool_req_001",
  "trace_id": "trace_001",
  "data": {},
  "error": null
}
```

拒绝响应：

```json
{
  "success": false,
  "code": "TOOL_NOT_ALLOWED",
  "message": "tool or action is outside execution context",
  "request_id": "tool_req_001",
  "trace_id": "trace_001",
  "data": null,
  "error": {
    "reason": "TOOL_ACTION_DENIED"
  }
}
```

Gateway 校验：

1. Execution Context 存在且未过期；
2. Tool/action 被允许；
3. Resource 在 scope；
4. 使用 context 的 tenant/biz 执行业务查询；
5. 写简单 Trace；
6. 拒绝时无业务副作用。

---

## 11. 最小状态模型

### tenant_biz_agent

```text
logical_agent_id PK
tenant_id
biz_domain
status
current_runtime_instance_id
last_active_at
UNIQUE(tenant_id, biz_domain)
```

### agent_runtime_instance

```text
runtime_instance_id PK
logical_agent_id
openclaw_agent_id
status
started_at
last_active_at
unloaded_at
restored_from_runtime_instance_id
```

### agent_task

```text
task_id PK
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
l2_session_id
task_type
status
input_json
result_json
current_step
last_active_at
```

### execution_context

```text
execution_context_id UUID PK
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
allowed_skills JSONB
allowed_tools JSONB
resource_scope JSONB
expires_at
```

### agent_memory

```text
memory_id PK
tenant_id
biz_domain
logical_agent_id
session_id
task_id
memory_type
content
created_at
```

### agent_trace

```text
trace_event_id PK
trace_id
tenant_id
biz_domain
logical_agent_id
session_id
task_id
event_type
decision
reason
event_json
created_at
```

---

## 12. 状态机

### L1

```text
PROVISIONING → ACTIVE → IDLE → CHECKPOINTING → UNLOADED
UNLOADED → PROVISIONING
```

### L2

```text
QUEUED → RUNNING → COMPLETED/FAILED → CHECKPOINTED → UNLOADED
```

非法状态转换必须返回领域错误。

---

## 13. 明确非契约项

第一版不定义：

```text
Capability Token claims
JWT/JWS/PASETO
nonce/revoke/replay 协议
Redis lock
MinIO object contract
Outbox/event contract
审计 hash chain
生产 IAM/RBAC
```

这些不应出现在 Demo 的必需接口和 Gate 中。
