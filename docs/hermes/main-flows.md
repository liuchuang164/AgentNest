# Hermes 16 条主流程约束

## 1. 使用方式

这 16 条流程是 Hermes 开发、测试和 Trace 的共同主线。实现可以拆分模块，但不得
省略关键边界或把外部系统职责放进 Hermes。

每条流程至少记录：

```text
request_id
trace_id
tenant_id
biz_domain（适用时）
run_id（适用时）
status_before / status_after
decision_code
external_call（适用时）
```

---

## F01 可信接入与模式分流

```text
认证入口注入 trusted context
→ 校验 body 与 trusted scope
→ 读取 execution_mode
→ 路由 HERMES_ONLY / OPENCLAW_ONLY / HERMES_OPENCLAW
```

约束：

- mode 不是模型判断结果；
- `OPENCLAW_ONLY` 不进入 Hermes；
- scope 不一致立即拒绝；
- 只有混合模式创建 orchestration Run。

---

## F02 HERMES_ONLY 直接响应

```text
创建最小 Run
→ 构造 standalone prompt
→ ModelProvider
→ Schema/Policy 校验
→ 返回结果
```

约束：

- 不加载复杂 SOP；
- 不创建 DAG；
- 不查询 Binding/资源；
- Control Plane/OpenClaw 调用次数为 0。

---

## F03 混合模式任务识别

```text
创建 HermesRun
→ 识别 biz_domain/task_type
→ 提取目标、约束、完成标准、风险
→ 校验 tenant capability catalog
```

约束：

- tenant/user 不由模型提取覆盖；
- 分类输出必须结构化；
- 歧义且影响安全/成本时进入人工确认或失败。

---

## F04 Agent Binding 解析

```text
Hermes 调 resolve_agent
→ ACTIVE / BUSY / RESTORABLE / ABSENT / DENIED
→ 记录外部事实
→ Hermes 按 SOP 决定下一步
```

约束：

- Hermes 不读写 Binding Registry；
- `DENIED` 不允许 fallback 到其他 tenant Agent；
- 恢复/创建由 Control Plane 执行；
- Agent 繁忙是决策输入，不是自动排队指令。

---

## F05 SOP 选择与版本锁定

```text
tenant + biz + task
→ 查询已发布 SOP
→ 运行时 Schema 校验
→ 锁定 sop_id/version
→ 保存 Run 引用
```

约束：

- 不跨 scope fallback；
- 锁定后不静默漂移；
- 找不到返回 `SOP_NOT_FOUND`；
- SOP 不是执行授权。

---

## F06 候选 DAG 规划

```text
trusted task summary + locked SOP + capability catalog
→ Planner
→ 结构化 TaskDag DTO
→ 规范化节点/依赖/输入/输出/完成标准
```

约束：

- Model output 未校验前不是领域 Plan；
- 节点必须声明 capability intent 和 write set；
- 不包含底层 Agent instance、节点地址或凭证。

---

## F07 DAG 静态校验

```text
Schema
→ node uniqueness
→ dependencies
→ acyclic
→ input closure
→ output schema
→ capability intent
→ write conflicts
→ join/completion/limits
```

约束：

- 任一步失败都不得派发；
- 错误码稳定；
- 可修复的 Planner 格式错误最多重试有限次数；
- 硬越权不通过模型重写尝试绕过。

---

## F08 查询真实执行条件

```text
validated candidate DAG
→ get_execution_context
→ resource/quota/rate-limit/budget/capability facts
→ 保存 observed_at 和有效期
```

约束：

- Hermes 不自行测 CPU/GPU；
- context 是短期快照，不是 reservation；
- scope mismatch 立即失败；
- 不缓存成长期权威资源状态。

---

## F09 执行策略决策

```text
candidate DAG + SOP + user constraints + execution context
→ SERIAL / PARALLEL / BATCHED_PARALLEL / QUEUE / HUMAN
→ 记录 DecisionRecord
```

约束：

- Hermes 决定业务策略；
- 并行度不得大于 context 可用值；
- 排队时间不得超过用户/SOP 上限；
- fallback 必须在 SOP 允许列表内；
- 降低目标必须显式标记。

---

## F10 资源预留、排队与派发

```text
reserve_execution
→ reservation success/reject
→ dispatch_execution 或 enqueue_execution
→ external_execution_id
```

约束：

- 无有效 reservation 不派发需要保证的执行；
- reservation TTL 到期必须重新决策；
- dispatch 带幂等键和 Plan version；
- Control Plane 拒绝后由 Hermes 决定 fallback；
- Hermes 不实现真实队列。

---

## F11 多 Agent 执行监控

```text
get_execution_status / signed callback
→ node status
→ RUNNING / WAITING_INPUT / PARTIAL / terminal
→ 更新 HermesRun 外部状态引用
```

约束：

- OpenClaw 如何创建 L2/L3 不属于 Hermes；
- Hermes 不轮询无上限；
- callback 必须校验 execution/run/scope；
- 外部结果文本视为不可信数据。

---

## F12 结构化结果接收

```text
terminal/partial execution result
→ 校验 response schema
→ 校验 plan/node 对应关系
→ 校验 artifact/evidence refs
→ 形成 EvaluationInput
```

约束：

- `COMPLETED` 不等于质量通过；
- 未知 node/result 拒绝；
- 结果引用不能指向其他 tenant；
- Hermes 不直接读取任意 URL。

---

## F13 全局质量验收

```text
deterministic checks
→ SOP business criteria
→ optional model rubric
→ PASS / REPLAN / WAITING_HUMAN / DEGRADED / FAIL
```

约束：

- 硬 Schema/required node 失败不能被模型 PASS 覆盖；
- 每个失败必须有 reason/evidence；
- `PASS` 后才生成完整成功响应；
- 质量判断和外部执行状态分开保存。

---

## F14 Fallback 与有界重规划

```text
Evaluation/Control Plane event
→ 选择 retry/replace/add/remove optional/change strategy
→ 创建 Plan version+1
→ 重新静态校验
→ 重新 context/reserve/dispatch
```

约束：

- 旧 Plan 不原地覆盖；
- 只重跑受影响节点闭包；
- 已有副作用先做幂等/复用判断；
- 达到 replan 上限后停止自动循环。

---

## F15 人工确认

```text
风险/预算/冲突/目标变化
→ WAITING_HUMAN
→ 展示 plan diff、原因、影响
→ APPROVE / MODIFY / ACCEPT_DEGRADED / CANCEL
```

约束：

- action 带 actor、scope、run version；
- 过期 action 拒绝；
- comment 不进入 system policy；
- 未批准前不执行高风险节点；
- 取消触发外部 cancel/release。

---

## F16 终态、释放与崩溃恢复

```text
COMPLETED/DEGRADED/FAILED/CANCELLED
→ release_execution
→ 保存最终 Evaluation/Decision
→ 返回结果

进程重启
→ 读取非终态 Run
→ get_execution_status 对账
→ 恢复到确定状态
→ 不重复派发
```

约束：

- release 幂等；
- release 暂时失败记录 `release_pending`；
- 终态业务结果不因 release 重试倒退；
- 恢复先对账外部状态；
- 不盲目重放 dispatch 或业务 Tool。

---

## 17. 流程验收要求

每条流程至少有：

- 一个 happy path；
- 一个关键负向用例；
- 结构化 Trace；
- 可复现 Fake 测试；
- 如有真实外部集成，明确标注真实证据。

任何一个流程依赖修改 OpenClaw/Control Plane 才能测试时，先用契约 Fake 完成
Hermes 验证，并将外部缺口记录为独立 ADR/Issue，不跨范围编码。
