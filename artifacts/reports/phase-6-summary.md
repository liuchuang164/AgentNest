# Phase 6 云端 Demo 验收摘要

- 结论：`INCOMPLETE`
- AgentNest commit：`-`
- OpenClaw stable：`2026.6.11`
- Node / pnpm：`-` / `-`

## 验收 Gate

| 检查 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| remote_read_only_preflight | PASS | `artifacts/reports/remote-preflight-summary.json` | SSH, host capacity and project-owned ports passed the read-only probe |
| repeatable_compose_deployment | MISSING | `artifacts/reports/phase-6-deployment-summary.json` | The same committed source and four loopback/private services passed at least two deployments |
| deployed_service_health | MISSING | `artifacts/reports/phase-6-status.json` | Control Plane, Gateway Mocks, PostgreSQL and OpenClaw are healthy |
| remote_platform_verification | MISSING | `artifacts/reports/phase-6-verification-summary.json` | Real PostgreSQL, scoped isolation, lifecycle and recovery evidence is aggregated |
| real_openclaw_l0_l1_l2_chain | BLOCKED_EXTERNAL | `artifacts/reports/phase-3-remote-e2e.json` | This check is real OpenClaw evidence, not the deterministic local E2E transport |

## 自动验证结果

| 类别 | 测试 | 状态 | 证据 |
| --- | --- | --- | --- |
| - | 尚无验证结果 | MISSING | - |

## 证据完整性

- artifacts/reports/phase-6-deployment-summary.json: missing
- artifacts/reports/phase-6-status.json: missing
- artifacts/reports/phase-6-verification-summary.json: missing

## 边界

- `pnpm test:e2e` 使用显式 fake OpenClaw transport，只验证应用编排，不冒充真实 OpenClaw。
- 真实三层链路只由远端 OpenClaw evidence 判定。
- LEGAL/ROBOT_DOG Tool 是确定性 Mock；副作用、DENY Trace 与 scope 查询落在真实 PostgreSQL 16。
- JWT/IAM、Redis、多节点 HA、MinIO、向量 Memory 和 Kubernetes 属于后续生产化建议。
