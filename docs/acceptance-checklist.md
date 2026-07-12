# AgentNest Demo 最终验收清单

> Codex 完成开发后逐项勾选，并填写真实测试名、Trace ID、命令输出摘要或证据路径。没有证据不得勾选。

## A. 构建

- [x] `pnpm install --frozen-lockfile` 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] lint 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] TypeScript strict typecheck 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] Unit tests 成功。证据：最终本地 Gate 135/135，`artifacts/reports/phase-6-implementation-summary.md`
- [x] Contract tests 成功。证据：最终本地 Gate 23/23，`artifacts/reports/phase-6-implementation-summary.md`
- [x] 真实 PostgreSQL/Gateway Integration tests 成功。证据：`real_postgres_16_node_adapter=PASS`，`artifacts/reports/phase-6-verification-summary.json`
- [x] Secret scan 成功。证据：214 个仓库文件通过，`artifacts/reports/phase-6-implementation-summary.md`
- [x] OpenAPI 3.1 文件生成并校验。证据：`openapi/agentnest.openapi.json`、`artifacts/reports/phase-2-summary.md`

## B. OpenClaw

- [x] 安装官方 stable 版本。证据：`artifacts/reports/remote-bootstrap-summary.json`
- [x] 版本不含 beta/alpha/rc/dev。证据：`artifacts/reports/phase-3-summary.md`
- [x] `openclaw doctor` 无阻断问题。证据：`artifacts/reports/remote-phase3-config-summary.json`
- [x] `openclaw gateway status` RPC 健康。证据：`artifacts/reports/phase-3-summary.md`
- [x] 第一版未修改 OpenClaw 核心源码。证据：仅使用官方 CLI/config 和外部 Qwen plugin，`artifacts/reports/phase-3-summary.md`

## C. L0 Main Agent

- [x] Main Agent 只拥有 L1 dispatch/status 能力。证据：`artifacts/reports/phase-3-summary.md`
- [x] Main Agent 看不到 LEGAL/ROBOT_DOG 业务 Skill。证据：远端 observed `skills: []`，`artifacts/reports/phase-3-summary.md`
- [x] Main Agent 不可调用业务 Tool。证据：六个业务 Tool 显式 deny，`artifacts/reports/phase-3-summary.md`

## D. L1 TenantBizAgent

- [x] 创建 `tenant_A + LEGAL` L1。证据：`tb_9fa3d61c2d63ee4285ee`，`artifacts/reports/phase-3-summary.md`
- [x] 创建 `tenant_A + ROBOT_DOG` L1。证据：`tb_9345ba25d7668764fb8a`，`artifacts/reports/phase-3-summary.md`
- [x] 创建 `tenant_B + LEGAL` L1。证据：`tb_4a8ee1cd63e0adcad74e`，`artifacts/reports/phase-3-summary.md`
- [x] 三者 `agentId` 不同。证据：`artifacts/reports/remote-phase3-config-summary.json`
- [x] 三者 workspace 不同。证据：7/7 distinct，`artifacts/reports/remote-phase3-config-summary.json`
- [x] 三者 agentDir 不同。证据：7/7 distinct，`artifacts/reports/remote-phase3-config-summary.json`
- [x] 三者 Session namespace 不同。证据：每 Profile 独立 agentDir，`artifacts/reports/phase-3-summary.md`
- [x] Skill allowlist 与 tenant/biz 配置一致。证据：远端 observed config，`artifacts/reports/phase-3-summary.md`
- [x] Tool allowlist 与 tenant/biz 配置一致。证据：远端 observed config，`artifacts/reports/phase-3-summary.md`
- [x] 相同 tenant/biz 重复请求复用 `logical_agent_id`。证据：`ensure-tenant-biz-agent.unit.test.ts`

## E. L2 TaskAgent

- [ ] L1 使用原生 `sessions_spawn` 创建 L2。证据：
- [ ] L2 使用独立 Session。证据：
- [x] L2 配置的 Skill/Tool 是 L1 的子集。证据：远端 3 个 L1/L2 observed Profile，`artifacts/reports/phase-3-summary.md`
- [ ] L2 请求父级未授权能力时被拒绝。证据：
- [ ] LEGAL happy path 完成。证据：
- [ ] ROBOT_DOG happy path 完成。证据：

## F. Tool 隔离

- [x] LEGAL 调 Robot Tool 被拒绝且无副作用。证据：`gateway-mocks.isolation.test.ts`、`artifacts/reports/phase-4-summary.md`
- [x] ROBOT_DOG 调 Legal Tool 被拒绝且无副作用。证据：`gateway-mocks.isolation.test.ts`、`artifacts/reports/phase-4-summary.md`
- [x] tenant_A context 读取 tenant_B 的 `case_001` 被拒绝。证据：body scope override 用例与 tenant-scoped fixture，`artifacts/reports/phase-4-summary.md`
- [x] 未授权 action 被拒绝。证据：`gateway-mocks.isolation.test.ts`
- [x] 未知/过期 `execution_context_id` 被拒绝。证据：`gateway-mocks.isolation.test.ts`
- [x] body 伪造 tenant/biz 不能覆盖服务端 context。证据：Fastify strict schema 用例，`gateway-mocks.isolation.test.ts`
- [x] 每次拒绝都有 `DENY` Trace 和原因。证据：本地 16 条 isolation tests；远端 `gateway_deny_trace_and_no_side_effect=PASS`，`artifacts/reports/phase-6-verification-summary.json`

## G. Skill 隔离

- [x] LEGAL Agent 看不到 Robot Skill。证据：远端 observed Skill allowlist，`artifacts/reports/phase-3-summary.md`
- [x] Robot Agent 看不到 Legal Skill。证据：远端 observed Skill allowlist，`artifacts/reports/phase-3-summary.md`
- [ ] Prompt 写出未授权 Skill 名称仍不能执行。证据：

## H. Memory 隔离

- [x] tenant_A/LEGAL 只读取 `ALPHA_LEGAL_MEMORY`。证据：`postgres-phase5-persistence-repository.integration.test.ts`、`artifacts/reports/phase-5-summary.md`
- [x] tenant_A/ROBOT_DOG 只读取 `ALPHA_ROBOT_MEMORY`。证据：`postgres-phase5-persistence-repository.integration.test.ts`、`artifacts/reports/phase-5-summary.md`
- [x] tenant_B/LEGAL 只读取 `BETA_LEGAL_MEMORY`。证据：`postgres-phase5-persistence-repository.integration.test.ts`、`artifacts/reports/phase-5-summary.md`
- [x] 同租户跨业务无泄漏。证据：远端三个 scope Memory canary，`artifacts/reports/phase-6-verification-summary.json`
- [x] 跨租户无泄漏。证据：远端三个 scope Memory canary，`artifacts/reports/phase-6-verification-summary.json`
- [x] 恢复只加载当前 tenant/biz 的 Memory 与 Summary。证据：`phase5-adapters.unit.test.ts`、`lifecycle-restore.test.ts`

## I. 生命周期

- [x] L2 在 TTL 前不因 TTL 卸载。证据：`lifecycle-reaper.test.ts`
- [x] L2 在 TTL 边界可 checkpoint/unload。证据：本地 `lifecycle-reaper.test.ts` 与远端 `deployed_ttl_unload_and_runtime_restore=PASS`
- [x] L2 卸载前 TaskState、Summary、Memory、Trace 已保存。证据：`phase5-checkpoint-writer.unit.test.ts`、`local-checkpoint-volume.unit.test.ts`
- [x] L1 在 TTL 前不因 TTL 卸载。证据：`lifecycle-reaper.test.ts`
- [x] L1 在 TTL 边界且无活动 L2 时可 unload。证据：本地生命周期测试与远端 `artifacts/reports/phase-6-verification-summary.json`
- [x] 活动 L2 阻止 L1 unload。证据：`lifecycle-reaper.test.ts`
- [x] 持久化失败阻止 `UNLOADED` 状态。证据：`lifecycle-reaper.test.ts`、`phase5-checkpoint-writer.unit.test.ts`

## J. 恢复

- [x] L1 恢复后 `logical_agent_id` 不变。证据：`lifecycle-restore.test.ts`
- [x] L1 恢复后 `runtime_instance_id` 改变。证据：`lifecycle-restore.test.ts`
- [x] `restored_from_runtime_instance_id` 正确。证据：`lifecycle-restore.test.ts`、`phase5-adapters.unit.test.ts`
- [x] Session Summary 恢复。证据：L1 local checkpoint fallback 与 task summary 用例，`phase5-adapters.unit.test.ts`、`lifecycle-restore.test.ts`
- [x] Memory 和 Trace 索引恢复。证据：`lifecycle-restore.test.ts` 与远端 restore evidence，`artifacts/reports/phase-6-verification-summary.json`
- [x] 未完成 TaskState 可读取或继续。证据：`lifecycle-restore.test.ts`、`postgres-phase5-persistence-repository.integration.test.ts`
- [x] 已移除 Tool 不会因旧状态恢复。证据：`CatalogCheckpointCapabilitySummarySource` current-policy intersection，`phase5-checkpoint-writer.unit.test.ts`
- [x] Control Plane 重启后可从 PostgreSQL 重建 Runtime cache。证据：`postgres_control_plane_openclaw_restart_and_new_task=PASS`，`artifacts/reports/phase-6-verification-summary.json`

## K. 云端部署

- [x] `config.txt` 未进入 Git 或报告。证据：`pnpm secret:scan`，`artifacts/reports/phase-3-summary.md`
- [ ] 干净服务器部署成功。证据：
- [x] 第二次部署可重复执行。证据：最终 commit 连续两次部署成功，`artifacts/reports/phase-6-deployment-summary.json`
- [x] OpenClaw、PostgreSQL、Admin API 未裸露公网。证据：loopback/private bindings 与 4/4 status，`artifacts/reports/phase-6-deployment-summary.json`、`artifacts/reports/phase-6-status.json`
- [ ] `pnpm demo:verify` 非交互运行并退出码为 0。平台 Gate 全部通过，但百炼 `Arrearage` 使真实链路按设计返回 `BLOCKED_EXTERNAL`/非零；证据：`artifacts/reports/phase-6-verification-summary.json`
- [x] README 记录实际 OpenClaw stable 版本。证据：`README.md`
- [x] 验证报告明确区分真实 OpenClaw 链路与 Mock Tool。证据：`artifacts/reports/phase-6-summary.md`

## L. 非验收项

以下内容未实现不影响第一版 Demo 通过：

```text
Capability Token/JWT/PASETO
Redis
MinIO
Kafka/Outbox
分布式锁与多节点 HA
向量数据库
OAuth/完整 RBAC
审计 hash chain
Kubernetes
生产计费、配额和大规模压测
```

## M. 最终结论

- [x] 没有跨租户/跨业务数据或 Memory 泄漏。证据：远端三个 scope Memory canary 与 DENY 无副作用 Gate。
- [x] 没有 L2 权限提升。证据：Capability intersection、配置/有效 Tool 视图与隔离测试。
- [ ] 三层 Agent 真实链路已运行。
- [x] 生命周期卸载与恢复已验证。证据：远端 lifecycle/recovery tests 均 PASS。
- [x] 已知限制已写入 README/报告。

```text
Name: Codex
Date: 2026-07-12
AgentNest deployed commit: 74b94e150c8982ed5487ffa23b2f90ade0834fef
OpenClaw version: 2026.6.11 (e085fa1)
Verification run_id: phase6_d4bb6ccc-4e8f-4397-b68c-8bed5ebf43a9
Conclusion: BLOCKED_EXTERNAL（平台 Gate PASS；模型供应商账务阻断真实链路）
```
