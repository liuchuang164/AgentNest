# AgentNest Phase 5 验收报告

- 结论：`PASS_LOCAL`
- 验收时间：`2026-07-12T03:18:30Z`
- 分支：`codex/lean-demo`
- 基线 commit：`3a9c0a941a6624c0245013e80c4556342b5be8a2`
- Node / pnpm：`v24.15.0 / 11.11.0`
- OpenClaw SDK / RPC 基线：官方 stable `2026.6.11`

## 本阶段交付

- PostgreSQL migration 与 scoped Repository：TaskState、Session Summary、Memory、Trace 索引、L1/L2 Checkpoint Artifact 和 Demo Tool completion marker；所有读取和变更均要求完整 `tenant_id + biz_domain`。
- 本地持久化 volume：按 logical/runtime/session/task 分层，Transcript 与恢复 Snapshot 分离，使用 SHA-256、原子 manifest、安全相对路径和 symlink/path traversal 拒绝。
- Lifecycle Reaper：L2 1h、L1 24h exact TTL，fake clock，先 L2 后 L1；active L2 阻止 L1；checkpoint、runtime unload 或状态写入失败均不伪造 `UNLOADED`。
- 恢复：logical ID 稳定、新 runtime/session ID、`restored_from_runtime_instance_id`、最终 L1 Summary、scoped Memory/Trace、未完成 TaskState；完整 Transcript 不注入模型。
- Capability 恢复按当前 Tenant Profile 与 Task Template 重新取交集，旧 Snapshot 中已撤销 Tool 不会复活。
- OpenClaw stable adapter：无模型调用的 `sessions.create`、只读 `chat.history` Transcript 导出、`sessions.delete` Transcript archive，以及 L1 Profile ensure/deactivate；恢复父 Session 绑定到新 runtime。
- Data Gateway 两个写 Tool 接入 durable completion marker；恢复后同 task/tool/action/resource 返回首次结果，不重复业务副作用，并记录 `TOOL_RESULT_REUSED`。
- 本阶段没有引入 Capability Token、Redis、MinIO、Outbox、分布式锁或其他任务书外安全设计。

## Gate 结果

| Gate | 结果 | 证据摘要 |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | 10 个 workspace，lockfile 无漂移 |
| `pnpm format:check` | PASS | Prettier 无 drift |
| `pnpm lint` | PASS | ESLint 0 warning/error |
| `pnpm typecheck` | PASS | TypeScript strict 通过 |
| `pnpm test:unit` | PASS | 20 files，121 tests |
| `pnpm test:contract` | PASS | 5 files，19 tests |
| `pnpm test:integration` | PASS_LOCAL | 5 files，37 tests；当前使用 recording PostgreSQL client |
| `pnpm test:isolation` | PASS | 1 file，16 tests |
| `pnpm test:lifecycle` | PASS | 3 files，19 tests |
| Plugin build / dist import | PASS | stable `2026.6.11` SDK build 与 runtime import 成功 |
| `pnpm secret:scan` | PASS | 171 个 Phase 5 commit 文件，未发现本地 config、SSH 或模型机密 |
| `git diff --check` | PASS | 无 whitespace error |

## 生命周期与恢复验收映射

| 要求 | 结果 | 自动化证据 |
|---|---|---|
| L2 TTL - 1s / TTL / TTL + 1s | PASS | `lifecycle-reaper.test.ts` |
| L1 TTL - 1s / TTL / TTL + 1s | PASS | `lifecycle-reaper.test.ts` |
| active L2 阻止 L1 unload | PASS | `lifecycle-reaper.test.ts` |
| checkpoint 失败不标记 unload | PASS | `lifecycle-reaper.test.ts`、`phase5-checkpoint-writer.unit.test.ts` |
| 三个 scope Memory canary 隔离 | PASS | `postgres-phase5-persistence-repository.integration.test.ts` |
| 多 L2 使用 exact Task Session Summary | PASS | `phase5-checkpoint-writer.unit.test.ts`、Repository exact lookup 用例 |
| restore 后再次 checkpoint 历史 Memory/Trace | PASS | 历史记录按 scope/logical/task 读取；当前 Task/Summary 使用新 runtime/session |
| logical ID 稳定、runtime/session ID 改变 | PASS | `lifecycle-restore.test.ts` |
| L1 fallback Summary 从本地 Snapshot 恢复 | PASS | `phase5-adapters.unit.test.ts` |
| 已撤销 Tool 不从旧状态复活 | PASS | `CatalogCheckpointCapabilitySummarySource` current-policy 用例 |
| 完成的写 Tool 不重复 | PASS | `gateway-mocks.isolation.test.ts`、`lifecycle-tool-once.test.ts` |

## 诚实边界

本报告证明 Phase 5 本地应用逻辑、SQL adapter、持久化文件、OpenClaw stable CLI/RPC 命令构造和失败传播。当前 integration suite 使用 recording PostgreSQL client，不冒充 PostgreSQL 16 真实执行；真实 migration/约束/事务、Compose 服务装配、Control Plane 重启恢复和 OpenClaw 远端 unload/restore 将在 Phase 6 执行。

恢复流程已经通过 stable `sessions.create` 创建新的 L1 父 Session；未完成 L2 TaskState 会绑定新的控制面 Session ID，实际原生 `sessions_spawn` 继续执行仍需在远端模型链路验证。当前百炼账号返回 `400 Arrearage`，因此本阶段只能标记 `PASS_LOCAL`，不能标记最终 Demo 完成。
