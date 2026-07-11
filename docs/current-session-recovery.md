# 当前 Codex 会话恢复步骤

当前本地 Codex 会话如果已经在旧版 Phase 2 上实现 Capability Token、JWS、revoke、replay、Redis、MinIO、Outbox 或类似生产安全机制，不要继续沿用该分支作为主实现。

建议操作：

```bash
# 1. 保存旧工作，避免丢失
# config.txt 已被忽略，不得加入提交
git switch -c backup/obsolete-security-phase2
git add -A
git restore --staged config.txt 2>/dev/null || true
git commit -m "wip: preserve obsolete security-heavy phase2"

# 2. 回到最新精简主线
git fetch origin
git switch main
git reset --hard origin/main

# 3. 检查最新约束
git log -1 --oneline
sed -n '1,240p' AGENTS.md
sed -n '1,340p' CODEX_TASK.md
```

然后只从 backup 分支手工迁移仍符合当前任务书的代码：

```text
可迁移：
pnpm monorepo
TypeScript strict
Fastify API skeleton
PostgreSQL migrations
Agent/Task/Memory/Trace models
fake clock
Vitest tests
基础 redaction

不要迁移：
Capability Token / JWT / JWS / PASETO
nonce / revoke / replay framework
Redis / MinIO / Kafka / Outbox
分布式锁 / 多节点 HA
审计 hash chain
生产 IAM / PKI
```

重新映射阶段：

```text
当前精简 Phase 1：工程骨架与领域模型
当前精简 Phase 2：Tenant Capability Profile + L1 Registry
当前精简 Phase 3：OpenClaw L0/L1/L2 真实链路
当前精简 Phase 4：execution_context_id + Gateway Mock
当前精简 Phase 5：持久化、TTL、卸载与恢复
当前精简 Phase 6：云端部署和验证
```

服务器使用用户名密码时：

```text
SSH_AUTH_MODE=password
SSH_PASSWORD=...
```

`config.txt` 权限为 `0600` 后直接运行只读 preflight；不得继续要求私钥、PKI、堡垒机或额外安全系统。