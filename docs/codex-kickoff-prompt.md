# Codex 启动提示词

在 Codex 打开本仓库后，可以直接使用下面的任务提示。`AGENTS.md` 是最高优先级约束，本提示不能覆盖它。

```text
你现在负责实现 AgentNest Demo。

先不要写代码。请按顺序完整阅读：
1. AGENTS.md
2. CODEX_TASK.md
3. docs/architecture.md
4. docs/contracts.md
5. docs/security-isolation.md
6. docs/lifecycle-persistence.md
7. docs/implementation-plan.md
8. docs/deployment-runbook.md
9. docs/validation-test-plan.md
10. docs/acceptance-checklist.md
11. docs/openclaw-baseline.md
12. docs/adr/0001-l1-profile-l2-native-subagent.md

读完后先输出：
- 你对不可变架构约束的理解；
- 风险与尚需探测的 OpenClaw stable 能力；
- Phase 1 的文件级实施计划；
- 本阶段测试 Gate；
- 你不会执行的高风险操作。

得到确认后，从 CODEX_TASK.md Phase 1 开始，小步实现并提交。每个 Phase 必须先通过本阶段 Gate，再进入下一阶段。

关键要求：
- L0 是固定 main Profile；
- L1 是 tenant_id + biz_domain 独立 OpenClaw Agent Profile；
- L2 是 L1 使用 sessions_spawn 创建的 native Sub-agent；
- L2 权限只能是 L1 权限子集；
- Skill/Tool/Memory/Session/Trace 必须跨租户、跨业务隔离；
- Prompt 不是安全边界；
- Tool 在 OpenClaw、Plugin、Gateway、资源归属层多重校验；
- L1 24h、L2 1h TTL 使用 fake clock 验证；
- checkpoint 失败时禁止卸载；
- 恢复必须创建新的 runtime_instance_id，并应用最新权限；
- 只部署 OpenClaw 官方最新 stable，禁止 beta/dev；
- config.txt 是本地只读机密文件，禁止回显、提交或写入报告；
- 远端只允许操作 REMOTE_WORKDIR 和本项目资源；
- 所有越权测试同时验证拒绝、零副作用、Audit 和 Trace。

用户会在本地 config.txt 中提供干净云服务器和模型配置。config.txt 不存在或不完整时，只完成本地可做的阶段并报告缺失字段，不要猜测凭证。

最终必须提供可重复命令：
pnpm demo:preflight
pnpm demo:deploy
pnpm demo:status
pnpm demo:verify
pnpm demo:report

不要用硬编码成功响应、跳过测试或只画图来宣称完成。
```

## 建议的持续工作提示

每个 Phase 结束时使用：

```text
请停止进入下一阶段。先执行当前 Phase 的全部 Gate，修复失败，更新文档和验证证据，然后给出：
1. 改动文件；
2. 架构约束如何落实；
3. 执行过的测试和真实结果；
4. 未解决问题；
5. 下一 Phase 计划。
```

远端部署前使用：

```text
请先运行只读 preflight。不得修改服务器。输出脱敏的环境兼容性报告、拟执行命令类别、服务拓扑、端口暴露情况和风险。确认 config.txt 不会被回显或复制。等我确认后再部署。
```
