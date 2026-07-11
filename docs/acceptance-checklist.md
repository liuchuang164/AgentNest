# AgentNest Demo 最终验收清单

> Codex 完成开发后逐项勾选，并在每一项后填写真实证据路径、Trace ID、测试名或部署清单字段。没有证据不得勾选。

## A. 构建与质量

- [ ] `pnpm install --frozen-lockfile` 成功。证据：
- [ ] lint 成功。证据：
- [ ] TypeScript strict typecheck 成功。证据：
- [ ] Unit tests 成功。证据：
- [ ] Contract tests 成功。证据：
- [ ] Integration tests 成功。证据：
- [ ] Secret scan 成功。证据：
- [ ] OpenAPI 3.1 文件生成并校验。证据：

## B. OpenClaw 基线

- [ ] 安装的是官方 stable channel。证据：
- [ ] 版本等于部署时官方最新稳定版。证据：
- [ ] 版本不含 beta/alpha/rc/dev。证据：
- [ ] `openclaw doctor` 无阻断问题。证据：
- [ ] `openclaw gateway status` 健康。证据：
- [ ] 配置 Schema hash 已记录。证据：
- [ ] 未修改 OpenClaw 核心，或已有批准 ADR。证据：

## C. L0 Main Agent

- [ ] Main Agent 只拥有 tenant agent 管理 Tool。证据：
- [ ] Main Agent 看不到 LEGAL/ROBOT_DOG 业务 Skill。证据：
- [ ] Main Agent 直接调用业务 Tool 被 Gateway 拒绝。证据：
- [ ] L0 路由 Trace 可查询。证据：

## D. L1 TenantBizAgent

- [ ] `tenant_A + LEGAL` 创建独立 L1。证据：
- [ ] `tenant_A + ROBOT_DOG` 创建独立 L1。证据：
- [ ] `tenant_B + LEGAL` 创建独立 L1。证据：
- [ ] 三者 agentId 不同。证据：
- [ ] 三者 workspace 不同。证据：
- [ ] 三者 agentDir 不同且未复用。证据：
- [ ] 三者 Session Store 不同。证据：
- [ ] Skill allowlist 实际 observed 与 Snapshot 一致。证据：
- [ ] Tool policy 实际 observed 与 Snapshot 一致。证据：
- [ ] Sandbox 为 agent scoped。证据：
- [ ] 相同 tenant+biz 重复请求复用同一 logical_agent_id。证据：
- [ ] 并发 ensure 不产生重复 active runtime。证据：

## E. L2 TaskAgent

- [ ] L1 使用原生 `sessions_spawn` 创建 L2。证据：
- [ ] 默认 context 为 isolated。证据：
- [ ] L2 有独立 Session/task_id。证据：
- [ ] L2 Capability 是父级子集。证据：
- [ ] L2 请求父级未授权能力在 spawn 前被拒绝。证据：
- [ ] LEGAL happy path 完成。证据：
- [ ] ROBOT_DOG happy path 完成。证据：
- [ ] L2 完成后立即 checkpoint。证据：

## F. Tool 隔离

- [ ] LEGAL 调 Robot Tool 被拒绝且无副作用。证据：
- [ ] ROBOT 调 Legal Tool 被拒绝且无副作用。证据：
- [ ] tenant_A Token 伪造 tenant_B body 被拒绝。证据：
- [ ] 未授权 action 被拒绝。证据：
- [ ] 错 Session Token 被拒绝。证据：
- [ ] 过期 Token 被拒绝。证据：
- [ ] 篡改 Token 被拒绝。证据：
- [ ] 无 Token 直调 Gateway 被拒绝。证据：
- [ ] 写 Tool replay 不产生第二个副作用。证据：
- [ ] 所有拒绝都有 Audit + Trace。证据：

## G. Skill 隔离

- [ ] LEGAL Agent 看不到 Robot Skill。证据：
- [ ] Robot Agent 看不到 Legal Skill。证据：
- [ ] Prompt 写出未授权 Skill 名称仍无法执行。证据：
- [ ] 共享 Skill 根中的未授权 Skill 被 allowlist 过滤。证据：
- [ ] Skill hash 篡改被检测。证据：

## H. Memory 隔离

- [ ] tenant_A/LEGAL canary 仅在本 scope 可召回。证据：
- [ ] tenant_A/ROBOT canary 仅在本 scope 可召回。证据：
- [ ] tenant_B/LEGAL canary 仅在本 scope 可召回。证据：
- [ ] 精确检索无跨租户泄漏。证据：
- [ ] 向量/语义检索无跨租户泄漏。证据：
- [ ] 同租户跨业务无泄漏。证据：
- [ ] Resource scope 生效。证据：
- [ ] 恢复只加载当前 tenant+biz summary。证据：

## I. 生命周期

- [ ] L2 在 TTL-1 不归档。证据：
- [ ] L2 在 TTL 边界归档。证据：
- [ ] L2 归档前 Session/Memory/Trace/TaskState 已持久化。证据：
- [ ] L1 在 TTL-1 不卸载。证据：
- [ ] L1 在 TTL 边界卸载。证据：
- [ ] 活动 L2 阻止 L1 卸载。证据：
- [ ] checkpoint 失败阻止卸载。证据：
- [ ] 多 Reaper 不重复处理。证据：
- [ ] Reaper 重启可恢复中间状态。证据：

## J. 恢复

- [ ] L1 恢复后 logical_agent_id 不变。证据：
- [ ] L1 恢复后 runtime_instance_id 改变。证据：
- [ ] `restored_from_runtime_instance_id` 正确。证据：
- [ ] Session Summary 恢复。证据：
- [ ] Transcript hash 验证成功。证据：
- [ ] 未完成 Task 从 checkpoint 继续。证据：
- [ ] 已完成写副作用不重复。证据：
- [ ] 权限撤销后旧权限不复活。证据：
- [ ] OpenClaw 重启后无 ghost child。证据：
- [ ] Control Plane 重启后 Registry 可恢复。证据：

## K. 故障与韧性

- [ ] PostgreSQL 故障时不接新任务、不卸载 Agent。证据：
- [ ] Redis 故障时不产生重复 L1。证据：
- [ ] MinIO 故障时 checkpoint 失败且不销毁运行态。证据：
- [ ] Gateway 超时不重复副作用。证据：
- [ ] OpenClaw 不健康时不虚假标记 L1 ACTIVE。证据：
- [ ] 配置热加载失败保持 last-known-good。证据：

## L. 云端部署

- [ ] `config.txt` 未进入 Git。证据：
- [ ] 远端部署可在干净服务器完成。证据：
- [ ] 第二次部署幂等。证据：
- [ ] OpenClaw/数据库/Redis/MinIO 未裸露公网。证据：
- [ ] SSH tunnel 验证成功。证据：
- [ ] `pnpm demo:verify` 非交互、退出码 0。证据：
- [ ] 部署清单已生成且脱敏。证据：
- [ ] 测试报告已生成且脱敏。证据：
- [ ] 项目清理脚本 dry-run 只包含本项目资源。证据：

## M. 最终结论

- [ ] 不存在 P0/P1 未解决问题。
- [ ] 所有已知限制已写入报告。
- [ ] Mock 能力和真实 OpenClaw 行为已明确区分。
- [ ] 仓库 Owner 已审阅验证报告。

最终验收人：

```text
Name:
Date:
AgentNest commit:
OpenClaw version:
Verification run_id:
Conclusion: PASS / FAIL
```
