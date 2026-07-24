# HERMES_CODEX_TASK.md — Hermes 认知编排服务实施任务书

## 0. 本任务书的作用

本任务书只用于 Hermes 工作流。它不替代现有 `CODEX_TASK.md` 的 OpenClaw Demo
任务，而是在独立分支上为 `apps/hermes/**` 建立单独的开发顺序和 Gate。

开始编码前必须完整阅读：

1. `AGENTS.md`
2. `apps/hermes/AGENTS.md`
3. `docs/hermes/README.md`
4. `docs/hermes/architecture.md`
5. `docs/hermes/main-flows.md`
6. `docs/hermes/contracts.md`
7. `docs/hermes/sop-dag.md`
8. `docs/hermes/control-plane-boundary.md`
9. `docs/hermes/security-isolation.md`
10. `docs/hermes/validation-test-plan.md`
11. `docs/hermes/acceptance-checklist.md`

本分支首先只补充约束。后续真正编码时才执行下面 Phase。

---

# Phase 0：基线核对与契约冻结

## 目标

确认 Hermes 作为认知编排层的边界，冻结 v1 API、Control Plane Tool 契约、状态机
和错误码，不接入真实 OpenClaw。

## 必须交付

- Hermes scope 清单与非目标；
- 三种调用模式路由契约；
- `HermesRun`、`SopDefinition`、`TaskDag`、`ExecutionPlan`、
  `QualityEvaluation` Schema；
- Control Plane v1 Client interface；
- 模型 Provider interface；
- 状态机和错误码；
- ADR：现有 OpenClaw L0/L1/L2 与目标 L0—L3 映射不由 Hermes 实现。

## Gate

- 所有契约可生成 TypeScript 类型和 JSON Schema；
- `OPENCLAW_ONLY` 明确不进入 Hermes；
- 没有修改 OpenClaw、Control Plane 或 Gateway 实现；
- 没有引入真实模型 SDK。

---

# Phase 1：Hermes 服务骨架与持久化

## 目标

创建可运行的 Hermes Fastify 服务、领域模型、PostgreSQL migration 和测试骨架。

## 建议目录

```text
apps/hermes/
  src/
    api/
    domain/
    application/
    infrastructure/
    prompts/
    workers/
  AGENTS.md
```

## 必须交付

- TypeScript strict 工程；
- Fastify API 和运行时 Schema；
- `HermesRun/Plan/Decision/Evaluation` 领域模型；
- 显式状态机；
- PostgreSQL Repository；
- Fake Clock、Fake Model、Fake Control Plane；
- 结构化日志和脱敏；
- `/health`。

## Gate

```bash
pnpm lint
pnpm typecheck
pnpm test
```

并验证非法状态转换、跨租户 Repository 查询和日志脱敏。

---

# Phase 2：HERMES_ONLY 直连模式

## 目标

完成简单请求直接调用 Hermes 主推理能力的最短链路。

## 必须交付

- `HERMES_ONLY` handler；
- 版本化 Prompt；
- ModelProvider timeout/cancel/error mapping；
- 结构化输出 Schema；
- Run 持久化和 Trace；
- 幂等请求处理。

## 硬约束

该模式不得：

- 加载复杂多 Agent SOP；
- 创建 Task DAG；
- 调用任何 Agent Control Plane Tool；
- 查询 Agent Binding；
- 调用 OpenClaw；
- 创建 Worker 或 reservation。

## Gate

测试必须证明所有 Control Plane/OpenClaw Fake 调用次数均为 0。

---

# Phase 3：SOP Registry、DAG Planner 与静态校验

## 目标

为混合模式实现版本化 SOP 解析、任务拆解和可重复校验的 DAG。

## 必须交付

- tenant/biz/task scoped SOP Registry；
- SOP 版本锁定；
- Planner Prompt 与结构化输出；
- DAG parser；
- 无环、依赖、输入、输出、write set、join policy 校验；
- execution strategy 候选；
- Plan 版本与变更原因。

## Gate

- 同一个固定模型输出产生同一规范化 DAG；
- 环、缺失依赖、重复节点、写冲突和越权 capability intent 被拒绝；
- 运行中 SOP 更新不会改变已锁定版本；
- tenant_A 无法加载 tenant_B SOP。

---

# Phase 4：Control Plane 契约与混合模式派发

## 目标

完成 `HERMES_OPENCLAW` 的两阶段决策和外部执行派发，不实现 Control Plane。

## 必须交付

- `resolve_agent`；
- `get_execution_context`；
- `reserve_execution`；
- `dispatch_execution`；
- `enqueue_execution`；
- `get_execution_status`；
- `cancel_execution`；
- `release_execution`；
- 可选 `hibernate_agent`；
- 稳定错误码与 timeout；
- reservation 过期处理；
- 执行状态轮询/回调的单一权威方案。

## Gate

- 先 query context，后由 Hermes 选择策略，再 reserve；
- 无 reservation 不派发需要保证的执行；
- Control Plane 不可用时不会伪造资源状态；
- `TOOL_RATE_LIMITED`、`AGENT_BUSY`、`WRITE_CONFLICT` 等事件由 SOP 决定下一步；
- 适配器不擅自选择业务 fallback。

---

# Phase 5：质量验收、重规划与人工确认

## 目标

形成有界的“执行—验收—重规划”闭环。

## 必须交付

- 结果 Schema 和 evidence reference 校验；
- QualityEvaluator；
- `PASS/REPLAN/WAITING_HUMAN/DEGRADED/FAIL`；
- 失败分类；
- Replan diff；
- 重规划次数上限；
- 人工确认接口；
- 取消和资源释放；
- 最终结果解释。

## Gate

- 不合格结果不会被标记成功；
- 仅重跑受影响节点；
- `max_replan_attempts` 达限后不再自动循环；
- 人工拒绝、超时和修改目标都有明确状态；
- terminal state 最终调用 `release_execution`，并支持幂等重试。

---

# Phase 6：安全、恢复、可观测性与端到端验证

## 目标

验证 Hermes 自身的租户隔离、进程恢复、全链路追踪和契约兼容。

## 必须交付

- trusted ingress context；
- SOP/Run/Plan/Decision tenant scope；
- Prompt injection 防护；
- 未完成 Run 恢复；
- 外部状态对账，避免重复派发；
- metrics/logs/traces；
- contract tests；
- Fake Control Plane + Fake OpenClaw E2E；
- 可选真实集成 smoke test，但不得在本 Phase 开发外部服务。

## Gate

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm hermes:verify
```

`hermes:verify` 必须非交互、失败返回非零，并输出哪些是 Fake、哪些是真实集成。

---

# 开发工作方式

每个 Phase：

- 先检查工作区和当前分支；
- 只暂存 Hermes scope 文件；
- 小步提交；
- Gate 失败必须修复或明确阻塞，不能伪造通过；
- 不读取、输出或提交 `config.txt/.env`；
- 不自动更新 OpenClaw Demo Issue #1；
- Hermes 工作应使用独立 Issue/PR；
- 需要跨工作流变更时停止并请求确认。

---

# 完成定义

只有同时满足以下条件才算 Hermes 工作流完成：

1. 三种模式不会误路由；
2. Standalone 模式保持单请求最短链路；
3. 混合模式真实执行两阶段资源决策；
4. DAG 可静态验证并阻止写冲突；
5. Hermes 的业务策略与 Control Plane 硬约束边界清楚；
6. 所有模型输出经过 Schema 校验；
7. 质量不达标能够有界重规划或进入人工确认；
8. tenant/biz SOP、Run、Plan、Decision 不交叉；
9. 进程恢复不重复派发已执行工作；
10. 未修改或实现 OpenClaw、Control Plane、Gateway 和业务 Skill；
11. `pnpm hermes:verify` 退出码为 0；
12. 没有机密、伪造证据或范围外实现。
