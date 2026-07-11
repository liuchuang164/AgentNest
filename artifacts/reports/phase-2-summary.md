# AgentNest Phase 2 验收报告

- 结论：`PASS_LOCAL`
- 验收时间：`2026-07-11T15:33:12Z`
- 分支：`codex/lean-demo`
- 基线 commit：`e2488814ca05ca00ade1e3ab050981ee8464a6f7`
- Node：`v24.18.0`
- pnpm：`11.11.0`

## 本阶段交付

- 生成源已切换到精简 `CapabilityProfile` 与服务端 `ExecutionContext`；旧 Capability Snapshot/Token 不再生成或导出。
- 三个 Demo scope 已进入代码 catalog 和幂等 PostgreSQL seed：
  - `tenant_A + LEGAL`
  - `tenant_A + ROBOT_DOG`
  - `tenant_B + LEGAL`
- Skill、Tool/action、Memory Scope 与 Task Template 使用普通集合交集；显式 L2 超集请求会拒绝。
- `logical_agent_id` 使用规范化 `tenant_id:biz_domain` 的 SHA-256 前 20 位稳定派生；runtime 重建使用新 `runtime_instance_id`。
- `EnsureTenantBizAgent` 通过 PostgreSQL repository 确保同 scope logical/runtime 复用，并只在权威查询成功后写入进程内 cache。
- PostgreSQL migration 提供 TenantBiz、版本化 Profile、Task Template、Logical Agent 和 Runtime Instance 表；部分唯一索引限制同一 logical L1 只有一个活跃 runtime。
- `PostgresTenantCapabilityCatalog` 从 PostgreSQL 读取启用的最新 Profile 与 Task Template；静态 catalog 仅用于 Demo fixture 和本地单元测试。
- workspace、agentDir、Session 和 Memory 路径只从合法稳定 logical ID 派生；测试覆盖 traversal、绝对路径和 symlink escape。
- 删除了遗留的 MinIO 空目录；本阶段未引入 Redis、MinIO、Outbox、JWT/JWS、replay 或 revoke 实现。

## Gate 结果

| Gate | 结果 | 证据摘要 |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | workspace lockfile 可复现安装 |
| `pnpm format:check` | PASS | Prettier 无 drift |
| `pnpm lint` | PASS | ESLint 0 warning/error |
| `pnpm typecheck` | PASS | TypeScript strict 通过 |
| `pnpm test:unit` | PASS | 10 files，32 tests |
| `pnpm test:contract` | PASS | 3 files，13 tests；包含 schema/OpenAPI/migration |
| `pnpm test:integration` | PASS | 1 file，2 adapter tests |
| `pnpm secret:scan` | PASS | 未读取或回显 `config.txt` 内容 |
| `git diff --check` | PASS | 无 whitespace error |

## 关键验收映射

| Phase 2 要求 | 自动化证据 |
|---|---|
| 相同 tenant/biz 复用 logical/runtime | `ensure-tenant-biz-agent.unit.test.ts` |
| 不同 tenant/biz 使用不同 logical ID 和目录 | `capability-identity.unit.test.ts`、`ensure-tenant-biz-agent.unit.test.ts` |
| runtime 重建后 ID 变化 | `ensure-tenant-biz-agent.unit.test.ts` |
| L2 能力为 L1 与模板交集 | `capability-intersection.unit.test.ts` |
| 未知 Skill/Tool/action/Memory 拒绝 | `capability-intersection.unit.test.ts`、`json-schemas.contract.test.ts` |
| 三个 Demo scope 与 seed 完整 | `capability-catalog.unit.test.ts`、`phase2-migration.contract.test.ts` |
| PostgreSQL 权威 Profile/Runtime adapter | `postgres-runtime-repository.integration.test.ts` |
| 路径无法 traversal/symlink escape | `runtime-paths.unit.test.ts` |

## 诚实边界

本机没有 Docker、`psql` 或正在运行的 PostgreSQL，因此本阶段没有宣称真实 PostgreSQL 进程测试通过。`test:integration` 使用协议兼容的 recording client 验证 SQL adapter 的查询、事务、advisory lock、Profile 读取、active runtime 复用和连接释放。真实 migration/seed 执行会在远端 preflight 后的部署阶段补证。

本阶段没有安装或运行 OpenClaw，也没有宣称 L0 → L1 → L2 链路、Gateway Mock、生命周期或恢复已经完成；这些分别属于 Phase 3、4、5 和 6。
