# CODEX_TASK.md — AgentNest Demo 实施任务书

## 0. 工作方式

Codex 必须先阅读：

1. `AGENTS.md`
2. `docs/architecture.md`
3. `docs/contracts.md`
4. `docs/security-isolation.md`
5. `docs/lifecycle-persistence.md`
6. `docs/validation-test-plan.md`

然后严格按本任务书阶段开发。禁止一上来堆全部代码、跳过契约、跳过负向隔离测试或直接在远端手工搭出不可复现环境。

每个阶段都要：

- 小步提交；
- 保持主干可构建；
- 先写测试或同步补测试；
- 更新文档；
- 生成脱敏验证证据；
- 不向仓库提交 `config.txt`、`.env` 或远端密钥。

---

# Phase 1：仓库骨架与契约

## 目标

创建 pnpm monorepo，先落地所有 Schema、状态机、接口契约和测试框架。

## 预期目录

```text
apps/
  control-plane/
  data-gateway-mock/
  external-gateway-mock/
packages/
  contracts/
  capability/
  persistence/
  openclaw-adapter/
  tenant-runtime-plugin/
  test-support/
skills/
  legal-evidence-check/
  robot-dog-health-check/
infra/
  docker-compose.yml
  postgres/
  minio/
  openclaw/
scripts/
  deploy/
  verify/
  dev/
tests/
  e2e/
  security/
  resilience/
artifacts/
  reports/
```

## 必须交付

- `package.json`、`pnpm-workspace.yaml`、严格 TypeScript 配置；
- lint、format、typecheck、test 命令；
- OpenAPI 3.1 初稿；
- JSON Schema：TaskRequest、CapabilitySnapshot、CapabilityToken、AgentState、TraceEvent；
- 显式状态机 enum；
- fake clock 接口；
- CI workflow：lint、typecheck、unit、contract、secret scan；
- 架构约束测试，防止包层级反向依赖。

## Gate

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contract
```

全部通过才能进入 Phase 2。

---

# Phase 2：Tenant Capability Registry 与安全模型

## 目标

实现全局能力定义、租户业务绑定、不可变 Snapshot 和 L2 短期 Token。

## 必须交付

- Capability Catalog：Skill、Tool/action、Memory Scope、Data Scope；
- `tenant_biz_capability_binding` 数据模型；
- `CapabilityResolver`；
- Snapshot 版本化和 hash；
- L2 权限交集算法；
- Capability Token 签发/验签；
- Token revoke/expiry；
- 审计事件；
- PostgreSQL migration；
- 单元测试和属性测试。

## 必测性质

```text
child ⊆ parent
revoked permission never reappears
unknown capability fails closed
tenant/biz mismatch fails closed
action-level privilege is enforced
same input snapshot has deterministic hash
```

## Gate

100% 覆盖核心交集、签名、过期、错租户、错业务、错 session、错 action 的分支。

---

# Phase 3：Agent Runtime Registry、L1 生命周期和持久化

## 目标

实现逻辑 L1、运行实例、分布式 ensure、checkpoint、unload 和 restore。

## 必须交付

- 稳定 `logical_agent_id` 派生；
- 每次创建变化的 `runtime_instance_id`；
- PostgreSQL 权威 Registry；
- Redis 锁和心跳；
- 并发 `ensure` 去重；
- L1 状态机；
- checkpoint；
- MinIO Transcript/Artifact 存储；
- Session Summary；
- Reaper `run-once`；
- fake clock；
- 恢复链 `restored_from_runtime_instance_id`。

## 关键规则

- checkpoint 失败时禁止卸载；
- 有活动 L2 时禁止卸载 L1；
- Runtime cache 丢失后必须从 PostgreSQL 恢复；
- 不得把完整 Transcript 自动注回模型。

---

# Phase 4：OpenClaw 稳定版部署与 Adapter

## 目标

在干净云服务器上安装官方最新稳定版 OpenClaw，并由 AgentNest 控制面安全管理动态 L1 Profiles。

## 必须交付

- 解析最新 stable 版本脚本；
- 排除 prerelease 的自动测试；
- 精确版本安装；
- OpenClaw preflight/doctor；
- 配置 Schema 保存和 hash；
- `OpenClawConfigAdapter`；
- 创建/更新/移除 L1 Agent Profile；
- 每 L1 独立 workspace、agentDir；
- 严格 Skill allowlist；
- Tool allow/deny；
- per-agent sandbox；
- 配置热加载结果验证；
- 配置失败回滚或保留 last-known-good；
- 部署清单。

## 禁止

- 使用 `@beta`、`@dev`；
- 从 OpenClaw `main` 构建；
- 通过直接字符串替换破坏 JSON 配置；
- 共用 agentDir；
- 把模型密钥写入 Git。

---

# Phase 5：L0 Main Agent 与 L1 路由

## 目标

实现 L0 只负责平台路由，不直接执行真实业务。

## 必须交付

- L0 workspace 和最小 Skill/Tool；
- `tenant_agent.ensure`；
- `tenant_agent.dispatch`；
- 请求校验；
- tenant-biz enabled 校验；
- L1 activate/restore；
- Trace 贯穿；
- 同一租户业务复用逻辑 L1；
- 不同租户业务得到完全独立的 Profile。

## 必测

- L0 看不到业务 Tool；
- L0 尝试直接访问 Data Gateway 被拒绝；
- 未开通 biz_domain 被拒绝；
- tenant_A/LEGAL 与 tenant_B/LEGAL 的 workspace/agentDir/session path 不同。

---

# Phase 6：L1 派生 L2 TaskAgent

## 目标

L1 使用 OpenClaw 原生 `sessions_spawn` 创建 L2，执行两个最小真实业务场景。

## Demo 业务

### LEGAL

```text
Skill: legal-evidence-check
Tools:
  legal.case.read
  legal.analysis.write
Forbidden:
  robot.device.read
  robot.device.command
```

### ROBOT_DOG

```text
Skill: robot-dog-health-check
Tools:
  robot.device.read
  robot.health.write
Forbidden:
  legal.case.read
  legal.analysis.write
```

## 必须交付

- L1 task template；
- L2 capability intersection；
- Capability Token；
- `sessions_spawn context=isolated`；
- TaskState；
- Tool call trace；
- completion checkpoint；
- L2 1 小时 Reaper；
- OpenClaw auto-archive 与数据库 Reaper 协同。

## 必测

- LEGAL L2 调 Robot Tool 被拒绝；
- ROBOT L2 调 Legal Tool 被拒绝；
- tenant_A L2 伪造 tenant_B 参数仍被拒绝；
- L2 请求父级没有的 Tool 在 spawn 前被拒绝；
- 伪造 Token/过期 Token/错 action 均被 Gateway 拒绝。

---

# Phase 7：Memory、Session、Trace 隔离与恢复

## 目标

证明销毁前持久化、销毁后恢复，并且不发生跨租户召回。

## 必须交付

- Session Summary Store；
- Transcript MinIO URI/hash；
- Memory Store，查询强制 tenant+biz filter；
- Trace Event Store；
- Task checkpoint；
- L1/L2 unload；
- restore；
- 重启恢复；
- 数据保留和清理策略。

## 必测

- tenant_A 写入 canary memory，tenant_B 精确查询和语义查询均得不到；
- LEGAL memory 不被 ROBOT_DOG 召回；
- 完成后 L2 卸载，Transcript 仍可验证 hash；
- L1 卸载后新 runtime_instance_id 恢复摘要；
- 被撤销 Tool 不会因旧 Snapshot 恢复；
- OpenClaw 重启后无幽灵 child；
- AgentNest 重启后 Reaper 可继续处理过期实例。

---

# Phase 8：远端一键部署和完整验证

## 目标

使用本地 `config.txt` 在用户提供的干净云服务器上重复部署并生成可审计报告。

## 必须交付

```text
scripts/deploy/preflight.sh
scripts/deploy/install-openclaw.sh
scripts/deploy/deploy.sh
scripts/deploy/status.sh
scripts/deploy/destroy-project-only.sh
scripts/verify/run-all.sh
scripts/verify/run-isolation.sh
scripts/verify/run-lifecycle.sh
scripts/verify/run-recovery.sh
scripts/verify/run-resilience.sh
```

要求：

- 所有脚本 `set -Eeuo pipefail`；
- 幂等；
- 所有路径有 allowlist；
- 输出脱敏；
- 不删除非项目资源；
- 通过 SSH tunnel 验证；
- 自动收集版本、健康状态、测试摘要、Trace ID、Agent ID、Snapshot ID；
- 原始敏感日志不回传 Git。

## 最终命令目标

```bash
pnpm demo:deploy
pnpm demo:verify
pnpm demo:report
```

最终 `pnpm demo:verify` 必须非交互执行、退出码可靠、可重复运行。

---

# Phase 9：交付报告

生成：

```text
artifacts/reports/deployment-manifest.json
artifacts/reports/test-summary.json
artifacts/reports/isolation-matrix.md
artifacts/reports/lifecycle-recovery.md
artifacts/reports/openclaw-compatibility.md
artifacts/reports/security-findings.md
```

报告必须脱敏，并明确区分：

- 真实执行证据；
- Mock 行为；
- 尚未验证的假设；
- 已知限制；
- 后续生产化建议。

---

# 绝不允许的“伪完成”

以下任一情况均不算完成：

- 只画架构图，没有运行代码；
- 只在内存 Map 模拟 Agent 生命周期；
- 只通过 Prompt 声称隔离；
- 越权测试只看返回文案，不验证副作用；
- 使用相同 agentDir 模拟多个 L1；
- 手工改数据库时间但没有 fake clock/可复现脚本；
- 真等 24 小时；
- 测试时关闭授权；
- 把错误吞掉后返回 success；
- 只测试 happy path；
- 在报告中隐藏失败项；
- 使用 beta OpenClaw 以绕过实现困难；
- 将 config.txt 或密钥提交到 Git。
