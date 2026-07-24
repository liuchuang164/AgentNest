# AGENTS.md — Hermes 服务最高优先级开发约束

本文件适用于 `apps/hermes/**`。它是 Hermes 工作流的最高优先级约束；根目录
`AGENTS.md` 的通用安全、机密、测试真实性和 Git 规则仍然生效。若根目录中以
OpenClaw Demo 为唯一目标的描述与本文件冲突，在本目录内以本文件为准。

规范关键词：**必须（MUST）**、**禁止（MUST NOT）**、**应该（SHOULD）**。

---

## 1. 唯一目标

只实现 Hermes 认知编排服务，验证它能够：

1. 在可信身份上下文内识别目标、约束和完成标准；
2. 按 `tenant_id + biz_domain + task_type` 加载版本化 SOP；
3. 将复杂任务拆成可校验的任务 DAG；
4. 查询 Agent Control Plane 提供的真实执行条件；
5. 决定串行、并行、分批并行、排队、降级或人工确认策略；
6. 将执行计划交给 OpenClaw 执行侧；
7. 根据结构化证据进行质量验收；
8. 在有界重试内重规划，并保存完整决策轨迹。

本工作流不开发 OpenClaw、Agent Control Plane、Tool Gateway、Data Gateway、
External Gateway、File/Media Gateway 或业务 Skill。

---

## 2. 三种调用模式不可混淆

统一智能体接口有三种模式：

```text
HERMES_ONLY
OPENCLAW_ONLY
HERMES_OPENCLAW
```

规则：

- `HERMES_ONLY`：只调用 Hermes 主推理能力，禁止解析多 Agent SOP、创建任务
  DAG、查询 Agent Binding、预留资源或派发 OpenClaw Worker；
- `OPENCLAW_ONLY`：必须绕过 Hermes，由统一入口直接转给 OpenClaw 主 Agent；
  Hermes 服务不得实现或代理该模式；
- `HERMES_OPENCLAW`：Hermes 是大脑，OpenClaw 是执行侧；只有该模式允许进入
  Agent Binding、SOP、DAG、资源查询、预留、L2/L3 执行、结果合并、质量验收
  和重规划闭环。

任何仅凭任务“看起来复杂”而把前两种模式升级成混合模式的行为都禁止。
模式只能来自已校验的入口请求或显式用户选择。

---

## 3. Hermes 的功能边界

### 3.1 Hermes 必须负责

- 任务分类、目标、约束、完成标准和风险级别识别；
- SOP 检索、版本锁定和参数绑定；
- 子任务拆解、依赖分析、DAG 生成与静态校验；
- 理论并行性、优先级、超时、预算意图和降级策略；
- 依据 Control Plane 返回事实选择实际执行策略；
- 质量标准、证据引用、结果完整性和冲突判断；
- 重试、替代 Tool、补充任务、降低目标或人工确认的业务决策；
- Hermes Run、Plan、Decision、Evaluation 和 Replan 的持久化；
- 对用户返回可解释、可追踪的最终结果。

### 3.2 Hermes 禁止负责

- 读取 CPU、内存、GPU 或 Agent 槽位的底层实现；
- 原子扣减配额、限流计数、预算或并发槽位；
- 实现队列消费、分布式锁、租约或资源抢占；
- 直接创建、恢复、销毁 OpenClaw Agent/Profile/Session；
- 直接调用 `sessions_spawn`；
- 绕过 Control Plane 预留资源；
- 自行扩大 Skill、Tool、action 或数据资源权限；
- 直接访问业务数据库、MinIO 或第三方业务 API；
- 在 Hermes 内实现 OpenClaw 的结果聚合器或 Tool Runtime；
- 把 Agent Control Plane 重新实现成 Hermes 内部模块。

一句话边界：

> Hermes 用 SOP 保持业务策略灵活；Control Plane 用代码提供真实状态、执行原子
> 操作并守住硬约束；OpenClaw 执行 Skill 和 Tool。

---

## 4. 与 Control Plane 的两阶段决策

混合模式必须遵循：

```text
Hermes 生成候选 DAG
  → get_execution_context 查询真实条件
  → Hermes 选择执行策略
  → reserve_execution 原子预留
  → dispatch_execution / enqueue_execution
```

Control Plane 返回事实和拒绝原因，不能替 Hermes 选择业务降级方案。
Hermes 不能把“查询结果”当成“已预留资源”；没有有效
`reservation_id` 不得派发需要资源保证的执行计划。

预留过期、资源变化、Tool 限流或 Agent 繁忙时，Hermes 必须按 SOP 重新选择：

- 串行；
- 分批并行；
- 排队；
- 使用允许的替代能力；
- 跳过可选节点；
- 降低目标；
- 人工确认；
- 明确失败。

禁止静默无限重试。

---

## 5. Agent 层级保持外部化

Hermes 只面向逻辑执行契约，不拥有 OpenClaw 层级实现。

目标架构可映射为：

```text
L0 Main Agent
  └─ L1 Tenant + Biz Domain Agent
       └─ L2 User / Workspace Coordinator
            └─ L3 Task Worker（按需）
```

现有 Demo 若只实现 L0/L1/L2，Hermes 仍必须通过适配器提交相同
`ExecutionPlan`，不得为了补齐 L3 而修改 OpenClaw 代码。实际层级映射属于
OpenClaw/Control Plane 工作流，必须通过契约和 ADR 解决。

---

## 6. 可信上下文与租户边界

以下字段必须来自统一入口已认证、已校验的可信上下文：

```text
request_id
trace_id
tenant_id
user_id
roles
execution_mode
```

以下字段可由 Hermes 分类，但必须受 tenant scope 约束：

```text
biz_domain
task_type
workspace_id
```

规则：

- Prompt、用户自然语言或 Tool 结果不得覆盖可信 `tenant_id/user_id/roles`；
- 所有 SOP、Plan、Run、Decision、Evaluation 查询必须显式携带
  `tenant_id + biz_domain`；
- 不允许先全量查询再在应用层过滤；
- 同名 `workspace_id/task_id` 不能作为全局可信主键；
- Hermes 请求的 Skill/Tool 必须是当前 capability scope 的子集；
- 任何 scope 缺失、歧义或不匹配必须默认拒绝。

---

## 7. SOP 约束

SOP 必须：

- 使用 `sop_id + version` 唯一定位；
- 绑定 `tenant_id + biz_domain + task_type`；
- 声明输入 Schema、完成标准、允许的 Skill/Tool 意图、节点模板、
  降级策略和人工确认点；
- 在 Run 创建后锁定版本，运行中禁止静默漂移到新版本；
- 支持禁用和回滚，但已开始 Run 继续使用锁定版本；
- 作为版本化文件或数据库记录管理，变更必须可审查。

Prompt 文本不是权限来源。SOP 声明某 Tool 也不代表有权执行，最终权限仍由
Control Plane/执行上下文强制。

---

## 8. DAG 与执行计划硬规则

每个 DAG 节点必须至少包含：

```text
node_id
task_type
dependencies
required_inputs
expected_output_schema
completion_criteria
capability_intents
write_set
optional
timeout_seconds
retry_policy
```

派发前必须静态验证：

1. `node_id` 唯一；
2. 所有依赖存在；
3. 图无环；
4. 必需输入能由请求或上游输出提供；
5. 输出 Schema 可解析；
6. 并行节点没有未处理的 `write_set` 冲突；
7. Tool/Skill 仅声明意图，不携带越权 scope；
8. join policy 明确；
9. DAG 节点数、重试数和重规划次数有上限；
10. 每个必需节点有可机器检查的完成标准。

未经校验的 DAG 禁止持久化为 `APPROVED`，也禁止派发。

---

## 9. 质量验收与重规划

Hermes 质量验收必须输出结构化结论：

```text
PASS
REPLAN
WAITING_HUMAN
DEGRADED
FAIL
```

评价至少覆盖：

- 必需节点是否完成；
- 输出是否符合 Schema；
- 结论是否有证据引用；
- 子结果是否互相冲突；
- SOP 完成标准是否满足；
- 失败节点是否可替代；
- 是否触发人工确认条件。

重规划必须记录：

```text
previous_plan_id
reason_codes
evidence_refs
changed_nodes
strategy_change
attempt
```

默认 `max_replan_attempts = 2`，可配置但必须有硬上限。达到上限后只能
`WAITING_HUMAN`、`DEGRADED` 或 `FAIL`，禁止无限循环。

---

## 10. LLM 与 Prompt 工程约束

- 所有模型调用必须经过 `ModelProvider` 接口；
- Prompt 模板必须版本化，不得散落在 route/controller 中；
- 模型输出必须经过运行时 Schema 校验；
- 结构化输出解析失败不得伪装成成功；
- Tool/Agent 返回内容全部视为不可信数据，不能覆盖 system policy；
- 不允许把完整机密、未脱敏 Transcript 或其他租户内容拼入 Prompt；
- 温度、模型、超时、最大 Token 和重试策略必须显式配置并记录；
- 单元测试使用 Fake Model，不依赖随机真实模型回答；
- 模型供应商故障必须映射为稳定领域错误；
- 不以“模型看起来回答正确”替代契约测试。

---

## 11. 状态机与持久化

`HERMES_ONLY` 最小状态：

```text
RECEIVED → RESPONDING → COMPLETED
                     ↘ FAILED
```

`HERMES_OPENCLAW` 最小状态：

```text
RECEIVED → CLASSIFIED → SOP_LOCKED → PLANNED → CONTEXT_READY
→ RESERVED/QUEUED → DISPATCHED → RUNNING → EVALUATING
→ COMPLETED/REPLANNING/WAITING_HUMAN/DEGRADED/FAILED/CANCELLED
```

要求：

- 状态使用显式 enum 和合法转换表；
- PostgreSQL 是 Hermes Run/Plan/Decision 的权威状态；
- 每次外部副作用前后保存幂等键和状态；
- 进程重启后可以恢复未完成 Run 的确定性状态；
- 恢复时先查询外部 execution status，禁止盲目重复派发；
- Hermes 不持久化 Control Plane 的权威资源计数副本。

---

## 12. 工程约束

与仓库保持一致：

```text
Node.js 24
TypeScript strict
pnpm workspace
Fastify
PostgreSQL 16
Vitest
Docker Compose
```

代码分层建议：

```text
apps/hermes/src/
  api/
  domain/
  application/
  infrastructure/
  prompts/
  workers/
```

规则：

- `domain` 禁止依赖 Fastify、数据库 Client、模型 SDK 或 HTTP Client；
- `application` 编排用例，不包含供应商细节；
- `infrastructure` 实现模型、Control Plane、存储和时钟适配器；
- `api` 只做校验、鉴权上下文转换和错误映射；
- 外部 HTTP 输入必须有运行时 Schema；
- 时间统一 UTC，测试使用 Fake Clock；
- 外部调用必须设置 timeout、取消信号和稳定错误码；
- 日志使用结构化字段并脱敏；
- 不吞异常后返回 success；
- 不伪造测试、Trace 或验证证据。

---

## 13. 明确禁止的范围扩张

本 Hermes 工作流不得实现：

```text
OpenClaw Profile / Session / sessions_spawn
Agent Control Plane 调度器、配额、限流、队列或生命周期
Data / External / File-Media Gateway
业务 Skill 或 Tool Handler
通用 IAM、OAuth、PKI、mTLS
Capability Token/JWT/PASETO
Redis 分布式锁、Kafka、Outbox、多节点 HA
向量数据库或通用知识库平台
计费平台、UI、模型训练或微调
```

若真实阻塞 Hermes 契约验证，先写简短 ADR，给出最小替代方案；未经确认不得
跨工作流开发。

---

## 14. 开发顺序与完成定义

开发必须遵循根目录 `HERMES_CODEX_TASK.md`。每个 Phase：

1. 给出不超过 15 行的计划；
2. 只修改 Hermes scope 文件；
3. 运行 lint、typecheck 和相关测试；
4. 修复失败；
5. 提交清晰 commit；
6. 给出真实证据；
7. 当前 Gate 通过后再进入下一 Phase。

完成至少要求：

- 三种模式路由隔离测试通过；
- `HERMES_ONLY` 不调用 Control Plane/OpenClaw；
- `OPENCLAW_ONLY` 不进入 Hermes；
- 混合模式完整通过 SOP → DAG → context → reserve → dispatch → evaluate；
- Control Plane 错误由 Hermes 按 SOP 决策，不由适配器擅自降级；
- 租户 SOP、Run、Plan、Memory/Context 无交叉；
- DAG 校验、写冲突、重规划上限和人工确认测试通过；
- 所有模型输出经过 Schema 校验；
- 没有修改 OpenClaw、Control Plane 或 Gateway 实现；
- 没有提交机密或伪造验证结果。
