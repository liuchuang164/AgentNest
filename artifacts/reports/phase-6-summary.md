# Phase 6 云端 Demo 验收摘要

- 结论：`PASS`
- AgentNest commit：`7227d4735752709c4ddfe426bd44b7a691c77636`
- Verification run：`phase6_a45e7650-6e59-436d-8a86-ada52399fa72`
- OpenClaw stable：`2026.6.11`
- Node / pnpm：`v24.18.0` / `11.11.0`

## 验收 Gate

| 检查 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
| remote_read_only_preflight | PASS | `artifacts/reports/remote-preflight-summary.json` | SSH, host capacity and project-owned ports passed the read-only probe |
| repeatable_compose_deployment | PASS | `artifacts/reports/phase-6-deployment-summary.json` | The same committed source and four loopback/private services passed at least two deployments |
| deployed_service_health | PASS | `artifacts/reports/phase-6-status.json` | Control Plane, Gateway Mocks, PostgreSQL and OpenClaw are healthy |
| remote_platform_verification | PASS | `artifacts/reports/phase-6-verification-summary.json` | Real PostgreSQL, scoped isolation, lifecycle and recovery evidence is aggregated |
| real_openclaw_l0_l1_l2_chain | PASS | `artifacts/reports/phase-3-remote-e2e.json` | This check is real OpenClaw evidence, not the deterministic local E2E transport |

## 自动验证结果

| 类别 | 测试 | 状态 | 证据 |
| --- | --- | --- | --- |
| real_openclaw_tests | control_plane_tenant_a_legal_l0_l1_l2_mock_tool | PASS | `reports/control-legal-tenant-a-response.json` |
| real_openclaw_tests | control_plane_tenant_b_legal_l0_l1_l2_mock_tool | PASS | `reports/control-legal-tenant-b-response.json` |
| real_openclaw_tests | control_plane_robot_l0_l1_l2_mock_tool | PASS | `reports/control-robot-response.json` |
| real_openclaw_tests | official_stable_gateway_rpc | PASS | `artifacts/reports/phase-3-remote-e2e.json` |
| real_openclaw_tests | l0_l1_native_sessions_spawn_l2 | PASS | `artifacts/reports/phase-3-remote-e2e.json` |
| postgres_tests | real_postgres_16_node_adapter | PASS | `reports/postgres-adapter-suite.log` |
| isolation_tests | three_scope_postgres_memory_canary_reads | PASS | `reports/memory-*-response.json` |
| isolation_tests | gateway_deny_trace_and_no_side_effect | PASS | `reports/deny-no-side-effect.json` |
| mock_tool_tests | gateway_mock_isolation_suite | PASS | `reports/isolation-suite.log` |
| mock_tool_tests | gateway_deny_trace_and_no_side_effect | PASS | `reports/deny-no-side-effect.json` |
| lifecycle_tests | fake_clock_lifecycle_suite | PASS | `reports/lifecycle-suite.log` |
| lifecycle_tests | deployed_ttl_unload_and_runtime_restore | PASS | `reports/lifecycle-admin-api.json` |
| recovery_tests | postgres_control_plane_openclaw_restart_and_new_task | PASS | `reports/recovery-suite.json` |

## 证据完整性

- 所需脱敏 JSON 证据均已读取。

## 边界

- `pnpm test:e2e` 使用显式 fake OpenClaw transport，只验证应用编排，不冒充真实 OpenClaw。
- 真实三层链路只由远端 OpenClaw evidence 判定。
- LEGAL/ROBOT_DOG Tool 是确定性 Mock；副作用、DENY Trace 与 scope 查询落在真实 PostgreSQL 16。
- JWT/IAM、Redis、多节点 HA、MinIO、向量 Memory 和 Kubernetes 属于后续生产化建议。
