# Codex 启动提示词

将下面内容直接交给 Codex。`AGENTS.md` 是最高优先级约束。

```text
你现在负责实现 AgentNest Demo，请直接开始编码，不要只输出架构建议。

仓库：
https://github.com/liuchuang164/AgentNest

目标：
基于 OpenClaw 官方最新稳定版，实现一个可部署、可自动验证的三层 Agent Demo：

L0 Main Agent
  └─ L1 TenantBizAgent（tenant_id + biz_domain 独立 Profile）
       └─ L2 TaskAgent（原生 sessions_spawn Sub-agent）

先完整阅读：
1. AGENTS.md
2. CODEX_TASK.md
3. README.md
4. docs/architecture.md
5. docs/contracts.md
6. docs/security-isolation.md
7. docs/lifecycle-persistence.md
8. docs/implementation-plan.md
9. docs/validation-test-plan.md
10. docs/acceptance-checklist.md
11. docs/deployment-runbook.md
12. docs/openclaw-baseline.md
13. docs/adr/0001-l1-profile-l2-native-subagent.md
14. GitHub Issue #1

核心要求：
- L0 是固定 main Profile，只做 tenant/biz 路由；
- L1 按 tenant_id + biz_domain 使用独立 OpenClaw Agent Profile；
- 每个 L1 独立 workspace、agentDir、Session namespace、Skill allowlist、Tool allowlist 和 Memory namespace；
- L2 必须由 L1 使用原生 sessions_spawn 创建；
- L2 Skill/Tool/action/Memory Scope 必须是 L1 的子集；
- LEGAL 与 ROBOT_DOG 的 Skill、Tool、Memory、Session 必须隔离；
- L1 默认空闲 24 小时卸载，L2 默认空闲 1 小时卸载；
- 生命周期测试使用 fake clock；
- 卸载前持久化 Session Summary、Memory、Trace 和 TaskState；
- 恢复后 logical_agent_id 不变，runtime_instance_id 改变；
- 至少一条任务必须真实经过 OpenClaw L0 → L1 → L2 → Mock Tool；
- 只使用 OpenClaw 官方 stable，禁止 beta/dev；
- config.txt 禁止提交或回显。

Demo 最小安全机制：
- 所有状态和数据查询必须带 tenant_id + biz_domain；
- Control Plane 在 PostgreSQL 创建服务端 execution_context；
- Plugin 调 Gateway Mock 时传 execution_context_id；
- Gateway 从服务端读取权威 tenant/biz、Tool/action 和 resource scope；
- Gateway 不相信模型 body 自报的 tenant/biz；
- Tool 越权测试验证：拒绝、业务数据无变化、Trace 记录 DENY。

明确不要实现：
- Capability Token/JWT/PASETO；
- nonce/revoke/rotation；
- PKI/mTLS/零信任网络；
- OAuth/完整 RBAC；
- Redis、MinIO、Kafka、Outbox；
- 分布式锁、多节点 HA；
- 向量数据库；
- 审计 hash chain；
- Kubernetes；
- 生产计费、配额和大规模压测。

这些只能写入未来生产化建议，不能阻塞 Demo。

技术栈：
- Node.js 24
- TypeScript strict
- pnpm
- Fastify
- PostgreSQL 16
- Vitest
- Docker Compose

最低 Demo scope：
- tenant_A + LEGAL
- tenant_A + ROBOT_DOG
- tenant_B + LEGAL

两个 LEGAL 租户都必须存在 case_001，用于验证不能只按 resource_id 查询。

开发顺序必须遵循 CODEX_TASK.md：
1. 工程骨架和领域模型；
2. tenant/biz 能力配置和 L1 Registry；
3. OpenClaw L0/L1/L2 真实链路；
4. execution context 和 Gateway Mock；
5. Memory/Session/Trace、生命周期和恢复；
6. 云端部署和最终验证。

每个 Phase：
- 先输出不超过 15 行的实施计划；
- 实际修改代码；
- 运行 lint、typecheck 和相关测试；
- 修复失败；
- 提交清晰 commit；
- 更新 Issue #1；
- 不伪造测试结果。

现在开始 Phase 1：
1. 检查分支和工作区；
2. 阅读上述文件；
3. 检查 config.txt 是否存在，但不要输出内容；
4. 创建 pnpm + TypeScript strict 工程；
5. 创建 Fastify API 骨架；
6. 创建 PostgreSQL migration；
7. 创建 Agent、RuntimeInstance、Task、Memory、Trace、ExecutionContext 模型；
8. 创建 fake clock；
9. 创建 Vitest 测试骨架；
10. 运行 lint、typecheck、test 并修复；
11. 更新 Issue #1；
12. 提交 Phase 1 commit。

不要继续讨论宏观方案，现在开始写代码。
```

## 每阶段结束提示

```text
先不要进入下一阶段。请执行当前 Phase 的所有 Gate，修复失败，然后给出：
1. 改动文件；
2. 实际运行的测试和结果；
3. 真实 OpenClaw 行为与 Mock 行为的区分；
4. 未解决问题；
5. 下一阶段计划。
```

## 远端部署前提示

```text
先运行只读 preflight，不要修改服务器。只报告：OS、CPU、内存、磁盘、Docker/Node 可用性、端口占用、REMOTE_WORKDIR 状态和 OpenClaw stable 版本解析结果。不得回显 config.txt 或任何密钥。确认后再部署。
```
