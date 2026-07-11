# Codex 远端 Preflight 收口指令

当 Codex 已经在旧版安全方案上工作，或者在远端连接前不断新增安全前置条件时，直接给它下面这段指令：

```text
停止继续扩大安全范围。

当前仓库最新 main 已明确采用 lean Demo 方案：
- 不实现 Capability Token/JWT/JWS/PASETO；
- 不实现 nonce/revoke/replay；
- 不引入 Redis、MinIO、Kafka、Outbox、分布式锁、HA、向量数据库或审计 hash chain；
- 使用 PostgreSQL 服务端 execution_context_id；
- 只验证 tenant_id + biz_domain 下的 Profile、Skill、Tool、Memory、Session、生命周期与恢复。

先执行：
1. 保存当前旧工作到 backup 分支，确认 config.txt 未被提交；
2. git fetch origin；
3. 读取最新 origin/main 的 AGENTS.md、CODEX_TASK.md 和 docs/codex-kickoff-prompt.md；
4. 不继续旧版 signed-token Phase 2；
5. 只保留仍符合当前任务书的工程骨架、Fastify、PostgreSQL、领域模型、fake clock 和 Vitest；
6. 删除或停用 Capability Token、JWS、revocation、replay、Redis、MinIO、Outbox 等旧实现；
7. 运行当前精简 Phase 的最终 Gate并提交。

config.txt 已配置且权限为 0600。
服务器使用用户名密码登录：
- SSH_AUTH_MODE=password；
- 不得要求改用私钥；
- 使用 sshpass -e、stdin 或 Node SSH library API 传递密码；
- 不得在命令行参数、日志、Issue 或报告中回显密码。

提交当前精简 Phase 后，立即运行只读 pnpm demo:preflight。
Preflight 只读取：
- OS / architecture；
- CPU / memory / disk；
- Node / npm / pnpm / Docker / Git；
- 目标端口；
- REMOTE_WORKDIR；
- OpenClaw stable 版本解析结果。

Preflight 不安装、不删除、不修改服务器。
完成后只汇报真实环境和真正的部署阻塞项，不再新增非任务书安全设计。
```