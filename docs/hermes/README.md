# Hermes Vibe Coding 约束导航

## 1. 定位

Hermes 是完整智能体服务中的认知编排与质量控制层：

```text
Hermes：理解、SOP、DAG、策略、验收、重规划
Control Plane：真实资源、原子操作、硬约束、队列、生命周期
OpenClaw：Agent Runtime、Skill、Tool 和任务执行
```

本目录只约束 Hermes 的开发，不授权修改另外两个工作流。

## 2. 三种调用模式

| 模式 | Hermes | OpenClaw | 复杂多 Agent |
|---|---:|---:|---:|
| `HERMES_ONLY` | 直接回答 | 不调用 | 否 |
| `OPENCLAW_ONLY` | 完全绕过 | 主 Agent 直接回答 | 否 |
| `HERMES_OPENCLAW` | 规划和验收 | 负责执行 | 是 |

只有第三种模式允许执行 Agent Binding、SOP、DAG、资源预留、并行 Worker、
质量验收和重规划。

## 3. 必读文档

1. [`../../apps/hermes/AGENTS.md`](../../apps/hermes/AGENTS.md)：Hermes 代码作用域最高优先级约束
2. [`../../HERMES_CODEX_TASK.md`](../../HERMES_CODEX_TASK.md)：阶段任务与 Gate
3. [`architecture.md`](architecture.md)：总体架构、模块和状态
4. [`main-flows.md`](main-flows.md)：Hermes 16 条端到端主流程
5. [`contracts.md`](contracts.md)：接口、事件、错误码和领域契约
6. [`sop-dag.md`](sop-dag.md)：SOP、DAG、并行、降级和重规划规则
7. [`control-plane-boundary.md`](control-plane-boundary.md)：Hermes 与 Control Plane 分工
8. [`security-isolation.md`](security-isolation.md)：可信上下文和租户隔离
9. [`validation-test-plan.md`](validation-test-plan.md)：可复现测试方案
10. [`acceptance-checklist.md`](acceptance-checklist.md)：最终验收证据清单
11. [`codex-kickoff-prompt.md`](codex-kickoff-prompt.md)：后续开发启动提示词

## 4. 开发者先回答的五个问题

任何实现开始前必须回答：

1. 这段代码是否只属于 Hermes？
2. 它是否只在 `HERMES_OPENCLAW` 模式触发复杂流程？
3. 这是业务策略还是平台硬约束？
4. 失败后由 SOP 决策，还是由外部系统强制拒绝？
5. 是否能用 Fake Adapter 完成 Hermes 测试，而无需修改外部服务？

如果第 1 或第 5 个问题答案是否定的，停止实现并请求跨工作流确认。

## 5. 非目标

```text
不开发 OpenClaw
不开发 Agent Control Plane
不开发 Tool/Data/External/File Gateway
不开发业务 Skill
不建设通用 IAM、队列、配额、限流、计费或生命周期平台
不把 Hermes 变成另一个 Runtime
```

## 6. 建议分支与 PR

Hermes 约束和后续实现必须使用独立分支、独立 Issue 和独立 PR。不得把 Hermes
开发进度写入现有 OpenClaw Demo Issue #1。
