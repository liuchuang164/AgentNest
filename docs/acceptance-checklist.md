# AgentNest Demo 最终验收清单

> Codex 完成开发后逐项勾选，并填写真实测试名、Trace ID、命令输出摘要或证据路径。没有证据不得勾选。

## A. 构建


- [x] `pnpm install --frozen-lockfile` 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] lint 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] TypeScript strict typecheck 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] Unit tests 成功。证据：`artifacts/reports/phase-2-summary.md`（32/32）
- [x] Contract tests 成功。证据：`artifacts/reports/phase-2-summary.md`（13/13）
- [ ] 真实 PostgreSQL/Gateway Integration tests 成功。Phase 2 adapter integration 2/2 已通过，真实 PostgreSQL 证据待远端阶段补齐：`artifacts/reports/phase-2-summary.md`
- [x] Secret scan 成功。证据：`artifacts/reports/phase-2-summary.md`
- [x] OpenAPI 3.1 文件生成并校验。证据：`openapi/agentnest.openapi.json`、`artifacts/reports/phase-2-summary.md`

## B. OpenClaw

- [ ] 安装官方 stable 版本。证据：
- [ ] 版本不含 beta/alpha/rc/dev。证据：
- [ ] `openclaw doctor` 无阻断问题。证据：
- [ ] `openclaw gateway status` 健康。证据：
- [ ] 第一版未修改 OpenClaw 核心源码。证据：

## C. L0 Main Agent

- [ ] Main Agent 只拥有 L1 ensure/dispatch/status 能力。证据：
- [ ] Main Agent 看不到 LEGAL/ROBOT_DOG 业务 Skill。证据：
- [ ] Main Agent 不直接调用业务 Tool。证据：

## D. L1 TenantBizAgent

- [ ] 创建 `tenant_A + LEGAL` L1。证据：
- [ ] 创建 `tenant_A + ROBOT_DOG` L1。证据：
- [ ] 创建 `tenant_B + LEGAL` L1。证据：
- [ ] 三者 `agentId` 不同。证据：
- [ ] 三者 workspace 不同。证据：
- [ ] 三者 agentDir 不同。证据：
- [ ] 三者 Session namespace 不同。证据：
- [ ] Skill allowlist 与 tenant/biz 配置一致。证据：
- [ ] Tool allowlist 与 tenant/biz 配置一致。证据：
- [ ] 相同 tenant/biz 重复请求复用 `logical_agent_id`。证据：

## E. L2 TaskAgent

- [ ] L1 使用原生 `sessions_spawn` 创建 L2。证据：
- [ ] L2 使用独立 Session。证据：
- [ ] L2 Skill/Tool 是 L1 的子集。证据：
- [ ] L2 请求父级未授权能力时被拒绝。证据：
- [ ] LEGAL happy path 完成。证据：
- [ ] ROBOT_DOG happy path 完成。证据：

## F. Tool 隔离

- [ ] LEGAL 调 Robot Tool 被拒绝且无副作用。证据：
- [ ] ROBOT_DOG 调 Legal Tool 被拒绝且无副作用。证据：
- [ ] tenant_A context 读取 tenant_B 的 `case_001` 被拒绝。证据：
- [ ] 未授权 action 被拒绝。证据：
- [ ] 未知/过期 `execution_context_id` 被拒绝。证据：
- [ ] body 伪造 tenant/biz 不能覆盖服务端 context。证据：
- [ ] 每次拒绝都有 `DENY` Trace 和原因。证据：

## G. Skill 隔离

- [ ] LEGAL Agent 看不到 Robot Skill。证据：
- [ ] Robot Agent 看不到 Legal Skill。证据：
- [ ] Prompt 写出未授权 Skill 名称仍不能执行。证据：

## H. Memory 隔离

- [ ] tenant_A/LEGAL 只读取 `ALPHA_LEGAL_MEMORY`。证据：
- [ ] tenant_A/ROBOT_DOG 只读取 `ALPHA_ROBOT_MEMORY`。证据：
- [ ] tenant_B/LEGAL 只读取 `BETA_LEGAL_MEMORY`。证据：
- [ ] 同租户跨业务无泄漏。证据：
- [ ] 跨租户无泄漏。证据：
- [ ] 恢复只加载当前 tenant/biz 的 Memory 与 Summary。证据：

## I. 生命周期

- [ ] L2 在 TTL 前不因 TTL 卸载。证据：
- [ ] L2 在 TTL 边界可 checkpoint/unload。证据：
- [ ] L2 卸载前 TaskState、Summary、Memory、Trace 已保存。证据：
- [ ] L1 在 TTL 前不因 TTL 卸载。证据：
- [ ] L1 在 TTL 边界且无活动 L2 时可 unload。证据：
- [ ] 活动 L2 阻止 L1 unload。证据：
- [ ] 持久化失败阻止 `UNLOADED` 状态。证据：

## J. 恢复

- [ ] L1 恢复后 `logical_agent_id` 不变。证据：
- [ ] L1 恢复后 `runtime_instance_id` 改变。证据：
- [ ] `restored_from_runtime_instance_id` 正确。证据：
- [ ] Session Summary 恢复。证据：
- [ ] Memory 和 Trace 索引恢复。证据：
- [ ] 未完成 TaskState 可读取或继续。证据：
- [ ] 已移除 Tool 不会因旧状态恢复。证据：
- [ ] Control Plane 重启后可从 PostgreSQL 重建 Runtime cache。证据：

## K. 云端部署

- [ ] `config.txt` 未进入 Git 或报告。证据：
- [ ] 干净服务器部署成功。证据：
- [ ] 第二次部署可重复执行。证据：
- [ ] OpenClaw、PostgreSQL、Admin API 未裸露公网。证据：
- [ ] `pnpm demo:verify` 非交互运行并退出码为 0。证据：
- [ ] README 记录实际 OpenClaw stable 版本。证据：
- [ ] 验证报告明确区分真实 OpenClaw 链路与 Mock Tool。证据：

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

- [ ] 没有跨租户/跨业务数据或 Memory 泄漏。
- [ ] 没有 L2 权限提升。
- [ ] 三层 Agent 真实链路已运行。
- [ ] 生命周期卸载与恢复已验证。
- [ ] 已知限制已写入 README/报告。

```text
Name:
Date:
AgentNest commit:
OpenClaw version:
Verification run_id:
Conclusion: PASS / FAIL
```
