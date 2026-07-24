# Hermes 开发 Codex 启动提示词

> 当前分支只负责补充约束；下面提示词供后续另一个编码任务使用。

```text
你现在只负责 AgentNest 中 Hermes 认知编排服务的开发。不要开发或修改 OpenClaw、
Agent Control Plane、Data/External/File Gateway、业务 Skill 或 Tool Handler。

仓库：
https://github.com/liuchuang164/AgentNest

开始前：
1. 从最新 Hermes 实现分支创建独立开发分支；
2. 检查工作区，只保留本任务文件；
3. 完整阅读：
   - AGENTS.md
   - apps/hermes/AGENTS.md
   - HERMES_CODEX_TASK.md
   - docs/hermes/README.md
   - docs/hermes/architecture.md
   - docs/hermes/main-flows.md
   - docs/hermes/contracts.md
   - docs/hermes/sop-dag.md
   - docs/hermes/control-plane-boundary.md
   - docs/hermes/security-isolation.md
   - docs/hermes/validation-test-plan.md
   - docs/hermes/acceptance-checklist.md

唯一目标：
实现 Hermes 的任务理解、SOP、DAG、策略、质量验收和有界重规划。

三种调用模式：
- HERMES_ONLY：Hermes 主推理直接响应，禁止 SOP DAG、Binding、reservation、
  Control Plane 和 OpenClaw 调用；
- OPENCLAW_ONLY：必须绕过 Hermes。Hermes 收到时返回 MODE_NOT_HANDLED_BY_HERMES；
- HERMES_OPENCLAW：只有该模式进入 SOP、DAG、资源查询、reservation、dispatch、
  质量验收和 Replan。

Hermes 必须负责：
- 目标、约束、完成标准；
- tenant+biz+task scoped SOP 和版本锁定；
- DAG 和静态校验；
- 串行/并行/分批/排队/降级/人工确认决策；
- 查询 Control Plane 事实后申请 reservation；
- 结构化质量验收；
- 有界 Replan；
- Run/Plan/Decision/Evaluation 持久化。

Hermes 禁止负责：
- 真实 CPU/内存/GPU/Agent slot；
- 配额、限流、队列、锁和 reservation 的实现；
- Agent Binding Registry；
- Agent/Profile/Session 创建、恢复、休眠、销毁；
- sessions_spawn；
- Tool 执行和业务数据库访问；
- OpenClaw 结果聚合实现；
- 外部服务的开发。

必须遵循两阶段决策：
candidate DAG
→ get_execution_context
→ Hermes choose strategy
→ reserve_execution
→ dispatch/enqueue

Control Plane 只返回事实和硬拒绝。业务 fallback 必须由 Hermes 按 SOP 决定，
Control Plane Client Adapter 不得擅自换 Tool、转串行或删除节点。

可信上下文：
- tenant_id/user_id/roles/execution_mode 来自认证入口；
- Prompt、用户 body、模型输出和 Tool 结果不能覆盖；
- 所有 SOP/Run/Plan/Decision/Evaluation Repository 查询强制 tenant_id+biz_domain；
- capability intent 必须经确定性校验，最终执行权限由外部硬约束收窄。

工程：
- Node.js 24
- TypeScript strict
- pnpm
- Fastify
- PostgreSQL 16
- Vitest
- Fake Clock / Fake Model / Fake Control Plane

按 HERMES_CODEX_TASK.md 逐 Phase 执行：
Phase 0 契约冻结
Phase 1 服务骨架
Phase 2 HERMES_ONLY
Phase 3 SOP/DAG
Phase 4 Control Plane 契约和混合派发
Phase 5 质量/Replan/Human Gate
Phase 6 安全/恢复/可观测性/E2E

每个 Phase：
- 先给不超过 15 行计划；
- 只修改 Hermes scope；
- 实际编码；
- 运行 lint/typecheck/test；
- 修复失败；
- 提交清晰 commit；
- 给出真实证据；
- Gate 通过后再进入下一 Phase。

如果需要改 OpenClaw、Control Plane 或 Gateway：
立即停止，说明接口缺口，给出所需契约或 ADR，不要跨范围实现。

禁止：
- 把 Fake 测试说成真实多 Agent；
- 无 reservation 派发；
- 无限模型重试或 Replan；
- 用模型自由文本代替 Schema；
- 提交 config.txt/.env/API Key；
- 把 Hermes 进度更新到现有 OpenClaw Demo Issue #1。

如果现在是全新实现，只执行 Phase 0。先冻结契约并运行契约校验；不要跳到真实
OpenClaw 集成。
```

## 每阶段收口提示

```text
停止扩大范围。只执行当前 Hermes Phase 的既定 Gate，修复已有失败，然后报告：
1. 改动文件；
2. 实际命令和结果；
3. Fake 与真实集成；
4. Hermes 与外部服务边界；
5. 未解决契约缺口；
6. 下一 Phase。

不得修改 OpenClaw、Agent Control Plane、Gateway 或业务 Skill。
```

## 防跑偏提示

```text
检查当前 diff。若出现 OpenClaw Profile、sessions_spawn、Agent Pool、配额、限流、
队列、Redis 锁、Gateway Tool Handler 或业务 Skill 实现，停止并移出本分支。
Hermes 只能通过接口表达意图和读取事实，不能实现外部运行时能力。
```
