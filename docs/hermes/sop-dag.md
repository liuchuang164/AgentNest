# Hermes SOP、任务 DAG 与重规划约束

## 1. SOP 的定位

SOP 是 Hermes 的业务决策依据，描述：

- 任务目标和完成标准；
- 常见子任务和依赖；
- 允许请求的能力意图；
- 串并行偏好；
- 资源不足和 Tool 失败时的业务 fallback；
- 何时必须人工确认；
- 如何进行质量验收。

SOP 不是：

- Tool 权限凭证；
- Agent 创建脚本；
- Control Plane 队列配置；
- 可执行任意代码的插件；
- 绕过租户隔离的全局 Prompt。

---

## 2. SOP 选择

选择键：

```text
tenant_id + biz_domain + task_type + requested_sop_version(optional)
```

选择规则：

1. 显式版本存在且 ACTIVE 时使用；
2. 未显式版本时选择当前发布版本；
3. 不得跨 tenant fallback；
4. 不得跨 biz domain fallback；
5. 找不到时返回 `SOP_NOT_FOUND`，不能让模型自由发明完整 SOP；
6. Run 创建后锁定 `sop_id + version`；
7. Replan 继续使用同一锁定版本，除非人工显式迁移并创建新 Run/Plan 版本。

---

## 3. SOP 最小结构

```yaml
sop_id: sop_case_preliminary_overview
version: 3
scope:
  tenant_id: tenant_A
  biz_domain: LEGAL
task_type: CASE_PRELIMINARY_OVERVIEW
input_schema_ref: schema://case-overview-input/v1
completion_criteria:
  - required_nodes_completed
  - result_schema_valid
  - conclusions_have_evidence_refs
node_templates: []
strategy_policy:
  parallel_when_independent: true
  default_join_policy: ALL_REQUIRED
fallback_policies: []
human_gates: []
limits:
  max_nodes: 32
  max_replan_attempts: 2
```

YAML/JSON 必须通过 Schema 校验后才能发布。运行期只读取已发布版本。

---

## 4. Planner 输入

Planner 只能接收：

- 已脱敏且当前 scope 可用的请求数据；
- 锁定 SOP；
- capability scope 摘要；
- 允许的 Schema catalog；
- 用户约束；
- 上一次 Plan/Evaluation（重规划时）。

不得接收：

- 其他租户 SOP 或 Memory；
- Control Plane 数据库连接；
- OpenClaw 配置目录；
- 未脱敏凭证；
- 可以覆盖 system policy 的 Tool 文本。

Planner 的模型输出必须先解析成 DTO，再构造领域对象。

---

## 5. DAG 校验顺序

必须按固定顺序执行，保证错误可复现：

1. 顶层 Schema；
2. 节点数量和字段长度上限；
3. 节点 ID 唯一性；
4. 依赖节点存在；
5. 有向无环；
6. 输入来源闭包；
7. 输出 Schema 是否已注册；
8. capability intent 是否在允许 catalog；
9. 并行 write set 冲突；
10. timeout/retry/optional 合法性；
11. join policy；
12. 每个 required node 的完成标准；
13. 整体 SOP 完成标准可被节点输出覆盖。

任何一项失败，Plan 进入 `REJECTED` 并保存 reason code，但不得派发。

---

## 6. 依赖与并行

理论上可并行必须同时满足：

```text
节点之间无依赖路径
required_inputs 已满足
write_set 无冲突
SOP 允许并行
不存在必须串行的业务规则
```

实际并行还必须在 `get_execution_context` 后满足：

```text
available_parallelism > 1
tenant_remaining_slots > 1
所需 Tool 并发可用
预算允许
Control Plane reserve 成功
```

Hermes 决定并行是否值得以及如何分批；Control Plane 只能收窄或拒绝资源申请。

---

## 7. Write Set

每个可能产生副作用的节点必须声明规范化 write set，例如：

```text
artifact://analysis/case_timeline.json
db://legal_analysis/case_001/overview
external://ali_farui/query-budget
```

规则：

- 完全相同 write target 的节点默认不可并行；
- 父路径/子路径冲突必须由 resolver 识别；
- append-only 只有在契约明确支持时才可并行；
- 未声明 write set 的只读节点仍需标记 `READ_ONLY`；
- 模型不能用任意字符串规避冲突；
- 最终 Control Plane 仍执行硬写冲突防护。

---

## 8. 执行策略

### `SERIAL`

适用于强依赖、并行无收益、资源不足或写冲突无法拆分。

### `PARALLEL`

适用于独立节点，且 reservation 覆盖全部并行度。

### `BATCHED_PARALLEL`

适用于理论并行节点多于可用槽位。Hermes 根据优先级和关键路径分批。

### `QUEUE`

适用于 SOP 允许等待且估算等待不超过用户限制。Control Plane 维护真实队列。

### `HUMAN_CONFIRMATION`

适用于高风险 Tool、目标变化、关键证据冲突、预算超限或无安全 fallback。

---

## 9. Fallback 决策

SOP 可以声明：

```yaml
fallback_policies:
  - on:
      code: TOOL_RATE_LIMITED
      tool: ali_farui
    choices:
      - USE_LOCAL_LEGAL_RAG
      - WAIT
      - SKIP_OPTIONAL
      - HUMAN_CONFIRMATION
  - on:
      code: AGENT_SLOT_UNAVAILABLE
    choices:
      - BATCHED_PARALLEL
      - SERIAL
      - QUEUE
```

Hermes 必须结合任务目标、用户约束和当前 context 选择，并记录选择理由。
Control Plane Client Adapter 不得直接执行第一个 choice。

禁止的 fallback：

- 使用未授权 Tool；
- 跨 tenant 查询；
- 关闭完成标准后仍返回完整成功；
- 无上限等待或重试；
- 将必需节点静默标为 optional。

---

## 10. Quality Gate

质量验收分三层：

### 10.1 确定性校验

- 节点状态；
- JSON Schema；
- 必填字段；
- evidence reference 格式；
- 输出引用可解析；
- join policy；
- 错误和 warning 完整。

### 10.2 业务规则校验

- SOP criterion；
- 必需证据/事实；
- 冲突；
- 风险阈值；
- 可接受降级条件。

### 10.3 模型辅助评价

只用于难以完全编码的语义一致性。输入必须包含明确 rubric，输出必须结构化。
模型评价不能覆盖前两层的硬失败。

---

## 11. Replan

允许的 Replan 操作：

```text
RETRY_NODE
REPLACE_CAPABILITY
ADD_NODE
REMOVE_OPTIONAL_NODE
CHANGE_STRATEGY
CHANGE_BATCH
WAIT
REQUEST_HUMAN
LOWER_GOAL（必须允许）
```

每次 Replan 必须：

- 保留原 Plan；
- 创建新 version；
- 指出 changed_nodes；
- 引用触发证据；
- 只重跑受影响的节点闭包；
- 检查已完成副作用是否可复用；
- 再次执行 DAG 静态校验；
- 再次查询 execution context；
- 必要时申请新 reservation。

禁止在原 Plan 上原地无痕修改。

---

## 12. 循环上限

默认：

```text
max_planner_parse_attempts = 2
max_node_retry_attempts = 2
max_replan_attempts = 2
max_human_revision_rounds = 3
```

这些值可由 SOP 在平台硬上限内收窄。达到上限后只能：

```text
WAITING_HUMAN
DEGRADED
FAIL
```

不得继续自动循环。

---

## 13. 示例：AI 案前速览

候选节点：

```text
A 案件基本信息抽取
B 案件时间线抽取
C 证据类型识别
D 证据链匹配（依赖 A/C）
E 法律依据检索（依赖 D）
F 结果汇总（依赖 A/B/D/E）
```

当 Control Plane 返回两个槽位：

```text
batch_1 = [A, B]
batch_2 = [C]
batch_3 = [D]
batch_4 = [E]
batch_5 = [F]
```

具体 OpenClaw Worker 如何派生不属于 Hermes。Hermes 只提交验证后的 Plan、批次、
完成标准和 capability intent。
