# Hermes 接口与领域契约

## 1. 通用响应

所有 Hermes API 响应至少包含：

```json
{
  "success": true,
  "code": "OK",
  "message": "human readable summary",
  "request_id": "req_001",
  "trace_id": "trace_001",
  "data": {},
  "error": null
}
```

错误响应的 HTTP 状态和领域 `code` 必须稳定；不得把供应商异常文本直接作为
公共错误码。

---

## 2. 统一入口契约

统一入口可以由上游 Agent Gateway 实现，不属于 Hermes 代码范围：

```http
POST /api/agent/invoke
```

```json
{
  "request_id": "req_001",
  "execution_mode": "HERMES_OPENCLAW",
  "tenant_id": "tenant_A",
  "user_id": "user_001",
  "biz_domain": "LEGAL",
  "workspace_id": "case_001",
  "task_type": "CASE_PRELIMINARY_OVERVIEW",
  "input": {
    "question": "请生成案前速览"
  },
  "constraints": {
    "max_latency_seconds": 180,
    "max_budget": 20,
    "allow_human_review": true
  }
}
```

上游路由：

| mode | 路由 |
|---|---|
| `HERMES_ONLY` | Hermes standalone endpoint |
| `OPENCLAW_ONLY` | OpenClaw main endpoint，绕过 Hermes |
| `HERMES_OPENCLAW` | Hermes orchestration endpoint |

`tenant_id/user_id/roles` 必须由认证层写入可信上下文，不能只相信 JSON body。

---

## 3. Hermes API

### 3.1 Standalone

```http
POST /api/hermes/respond
```

仅接受 `execution_mode=HERMES_ONLY`。响应不包含 `plan_id`、
`reservation_id` 或 `external_execution_id`。

### 3.2 创建混合编排

```http
POST /api/hermes/orchestrations
Idempotency-Key: <request scoped key>
```

接受 `execution_mode=HERMES_OPENCLAW`，返回：

```json
{
  "run_id": "hrun_001",
  "status": "PLANNED",
  "sop": {
    "sop_id": "sop_case_overview",
    "version": 3
  },
  "plan_id": "hplan_001"
}
```

### 3.3 查询 Run

```http
GET /api/hermes/orchestrations/{run_id}
```

Repository 查询必须同时使用可信 `tenant_id + biz_domain`，禁止只按 `run_id`。

### 3.4 取消

```http
POST /api/hermes/orchestrations/{run_id}/cancel
```

取消必须幂等，并调用外部 `cancel_execution` 和 `release_execution`（如适用）。

### 3.5 人工决定

```http
POST /api/hermes/orchestrations/{run_id}/human-actions
```

```json
{
  "action_id": "ha_001",
  "decision": "APPROVE_REPLAN",
  "expected_run_version": 7,
  "comment": "允许切换本地 Legal RAG"
}
```

允许值必须为有限 enum，例如：

```text
APPROVE_REPLAN
MODIFY_GOAL
ACCEPT_DEGRADED
CANCEL
```

---

## 4. SOP 契约

```json
{
  "sop_id": "sop_case_overview",
  "version": 3,
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "task_type": "CASE_PRELIMINARY_OVERVIEW",
  "status": "ACTIVE",
  "input_schema_ref": "schema://case-overview-input/v1",
  "node_templates": [],
  "completion_criteria": [],
  "fallback_policies": [],
  "human_gates": [],
  "created_at": "2030-01-01T00:00:00Z"
}
```

唯一键：

```text
(tenant_id, biz_domain, task_type, sop_id, version)
```

运行时只保存引用和规范化快照 hash；不得跨 tenant fallback 到同名 SOP。

---

## 5. DAG 节点契约

```json
{
  "node_id": "case_timeline_extract",
  "task_type": "CASE_TIMELINE_EXTRACT",
  "dependencies": ["material_to_text"],
  "required_inputs": [
    {
      "source": "node:material_to_text",
      "schema_ref": "schema://material-text/v1"
    }
  ],
  "expected_output_schema": "schema://case-timeline/v1",
  "completion_criteria": [
    {
      "criterion_id": "timeline_schema_valid",
      "type": "SCHEMA_VALID"
    }
  ],
  "capability_intents": {
    "skills": ["case-timeline-extract"],
    "tools": []
  },
  "write_set": ["artifact://analysis/case_timeline.json"],
  "optional": false,
  "timeout_seconds": 60,
  "retry_policy": {
    "max_attempts": 2,
    "retry_on": ["TRANSIENT_MODEL_ERROR"]
  }
}
```

`capability_intents` 不是授权；Control Plane/Execution Context 可以收窄或拒绝。

---

## 6. Execution Plan

```json
{
  "plan_id": "hplan_001",
  "run_id": "hrun_001",
  "version": 1,
  "strategy": "BATCHED_PARALLEL",
  "requested_parallelism": 2,
  "priority": "HIGH",
  "max_queue_wait_seconds": 60,
  "join_policy": "ALL_REQUIRED",
  "batches": [
    ["case_basic_info_extract", "case_timeline_extract"],
    ["evidence_type_detect"]
  ],
  "fallback": {
    "TOOL_RATE_LIMITED:ali_farui": "USE_LOCAL_LEGAL_RAG",
    "AGENT_SLOT_UNAVAILABLE": "SERIAL_EXECUTION"
  }
}
```

允许的 strategy：

```text
SERIAL
PARALLEL
BATCHED_PARALLEL
QUEUE
HUMAN_CONFIRMATION
```

计划中不得写入底层 CPU、节点地址、OpenClaw Profile 路径或数据库凭证。

---

## 7. Control Plane Client v1

### 7.1 `resolve_agent`

请求：

```json
{
  "tenant_id": "tenant_A",
  "biz_domain": "LEGAL",
  "user_id": "user_001",
  "workspace_id": "case_001",
  "trace_id": "trace_001"
}
```

响应状态：

```text
ACTIVE
BUSY
RESTORABLE
ABSENT
DENIED
```

返回逻辑 Agent 路由或稳定错误，不返回跨租户候选。

### 7.2 `get_execution_context`

```json
{
  "available_parallelism": 2,
  "tenant_remaining_slots": 2,
  "estimated_queue_wait_seconds": 20,
  "budget_remaining": 18.5,
  "tool_constraints": {
    "ali_farui": {
      "available_concurrency": 0,
      "retry_after_seconds": 120
    }
  },
  "capability_scope": {
    "skills": [],
    "tools": {}
  },
  "observed_at": "2030-01-01T00:00:00Z",
  "valid_for_seconds": 10
}
```

Hermes 只能把它当短期事实快照。

### 7.3 `reserve_execution`

请求包含 `plan_id`、requested parallelism、priority、budget ceiling、
write sets 和幂等键。成功：

```json
{
  "reserved": true,
  "reservation_id": "res_001",
  "reserved_parallelism": 2,
  "expires_in_seconds": 30
}
```

失败必须返回确定错误码；Control Plane 不修改 Hermes 计划。

### 7.4 `dispatch_execution`

请求必须携带：

```text
reservation_id
plan_id + plan_version
coordinator_agent_id
dispatch_idempotency_key
trace_id
```

成功返回 `external_execution_id`。

### 7.5 `enqueue_execution`

仅在 Hermes 选择 `QUEUE` 且 SOP 允许时调用。Hermes 提供 priority 和最长等待，
Control Plane 负责原子入队和消费。

### 7.6 `get_execution_status`

返回：

```text
QUEUED
RUNNING
WAITING_INPUT
PARTIAL
COMPLETED
FAILED
CANCELLED
```

并提供结构化节点状态和结果引用。

### 7.7 `cancel_execution/release_execution`

必须幂等。任何终态都应尝试 release；重复 release 返回成功或
`ALREADY_RELEASED`。

---

## 8. 执行结果

```json
{
  "external_execution_id": "exec_001",
  "status": "COMPLETED",
  "nodes": [
    {
      "node_id": "case_timeline_extract",
      "status": "COMPLETED",
      "schema_valid": true,
      "result_ref": "artifact://analysis/case_timeline.json",
      "evidence_refs": ["material://02_bank_receipt#page=1"],
      "warnings": []
    }
  ],
  "aggregate_result_ref": "artifact://analysis/overview.json",
  "error": null
}
```

Hermes 不信任 `status=COMPLETED` 本身；仍需按 SOP 进行质量验收。

---

## 9. Quality Evaluation

```json
{
  "evaluation_id": "eval_001",
  "run_id": "hrun_001",
  "plan_id": "hplan_001",
  "decision": "REPLAN",
  "criteria": [
    {
      "criterion_id": "all_required_nodes",
      "passed": false,
      "reason_code": "LEGAL_BASIS_MISSING",
      "evidence_refs": []
    }
  ],
  "conflicts": [],
  "missing": ["legal_basis"],
  "next_action": {
    "type": "ADD_NODE",
    "target": "local_legal_rag_search"
  }
}
```

禁止只保存自由文本“结果不太好”。

---

## 10. 错误码

### Hermes 输入/规划

```text
MODE_NOT_HANDLED_BY_HERMES
UNTRUSTED_CONTEXT
SCOPE_MISMATCH
SOP_NOT_FOUND
SOP_VERSION_UNAVAILABLE
MODEL_OUTPUT_INVALID
DAG_INVALID
DAG_CYCLE
DAG_WRITE_CONFLICT
CAPABILITY_INTENT_OUT_OF_SCOPE
REPLAN_LIMIT_REACHED
HUMAN_ACTION_CONFLICT
```

### Control Plane 映射

```text
AGENT_NOT_FOUND
AGENT_BUSY
RESOURCE_UNAVAILABLE
QUOTA_EXCEEDED
BUDGET_EXHAUSTED
TOOL_RATE_LIMITED
WRITE_CONFLICT
RESERVATION_REJECTED
RESERVATION_EXPIRED
EXECUTION_NOT_FOUND
CONTROL_PLANE_UNAVAILABLE
```

错误必须包含 `retryable`、可选 `retry_after_seconds` 和脱敏 details。

---

## 11. 幂等和版本

- API 使用 `Idempotency-Key`；
- Run 使用乐观 `version`；
- Plan 每次重规划版本递增；
- dispatch 使用稳定幂等键；
- human action 使用唯一 `action_id + expected_run_version`；
- release/cancel 必须幂等；
- 契约使用 `/v1` 或 Schema version；
- 未知 enum 必须拒绝或显式进入兼容分支，禁止静默当成成功。
