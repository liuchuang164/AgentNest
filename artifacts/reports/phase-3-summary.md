# AgentNest Phase 3 验收报告

- 结论：`BLOCKED_EXTERNAL`
- 验收时间：`2026-07-11T16:55:59Z`
- 分支：`codex/lean-demo`
- 基线 commit：`6b46e406a96d05454b2e1d86dc1f99195cc8635f`
- 本地 Node / pnpm：`v24.15.0 / 11.11.0`
- 远端 Node / pnpm：`v24.18.0 / 11.11.0`
- OpenClaw：`2026.6.11 (e085fa1)`，官方 npm `latest` stable
- OpenClaw Schema SHA-256：`d94f740aae95abfb2d54137737d390c114b9e89cf83f0ef5796da2cf05899b29`

## 已完成交付

- 使用官方 npm stable 精确安装 `openclaw@2026.6.11`；版本解析器拒绝 beta、alpha、RC 和 dev。
- 实现 typed `OpenClawAdapter`：Profile ensure/inspect/deactivate、严格 observed-state 对比、Gateway RPC dispatch 和固定 L2 `sessions_spawn` 请求。
- 在远端创建并观察到 7 个独立 Profile：固定 `main`、三个 L1、三个固定 L2；7 个 workspace 和 7 个 agentDir 均不同。
- L0 `skills: []`，Tool 仅有 `sessions_send`、`session_status`，并显式 deny 六个业务 Tool。
- LEGAL 与 ROBOT_DOG L1/L2 的 Skill、Tool allow/deny 和 `subagents.allowAgents` 已按业务域隔离；L2 Tool 集合是对应 L1 业务 Tool 的真子集。
- 两个版本化业务 Skill 和五个 workspace 模板已 materialize 到各自远端 workspace；L1 模板固定使用原生 `sessions_spawn`、目标 L2、`context: isolated`、`mode: run`。
- OpenClaw Gateway 使用项目 wrapper 和 systemd user service，loopback `127.0.0.1:18789`；启用 user linger 后 SSH 断开仍保持 RPC 健康。
- Qwen 官方外部插件已固定进入 `plugins.allow`；模型为 `qwen/qwen3.5-plus`，中国区 Standard endpoint。
- `openclaw config validate` 通过；`openclaw doctor --lint` 的 error 数为 0；Gateway RPC 健康探测通过。

## Gate 结果

| Gate | 结果 | 证据摘要 |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | 10 个 workspace，可复现安装 |
| `pnpm format:check` | PASS | Prettier 无 drift |
| `pnpm lint` | PASS | ESLint 0 warning/error |
| `pnpm typecheck` | PASS | TypeScript strict 通过 |
| `pnpm test:unit` | PASS | 12 files，54 tests；其中 adapter 17 tests |
| `pnpm test:contract` | PASS | 3 files，13 tests |
| `pnpm test:integration` | PASS | 1 file，2 persistence adapter tests |
| `pnpm secret:scan` | PASS | 130 个仓库文件无本地机密内容 |
| OpenClaw stable/install/config/doctor | PASS | `remote-bootstrap-summary.json`、`remote-phase3-config-summary.json` |
| 7 个 Profile 与 Skill/Tool/目录隔离 | PASS | `remote-phase3-config-summary.json`、`phase-3-remote-e2e.json` |
| 真实 L0 → L1 → L2 | BLOCKED | `phase-3-remote-e2e.json`；Qwen 返回 HTTP 400 `Arrearage`，未产生成功模型 turn 或 L2 Session |

## 远端 observed Profile 摘要

| Scope / Role | Agent ID | Skill | 业务 Tool 视图 |
|---|---|---|---|
| L0 | `main` | 空 | 空；六个业务 Tool 全部 deny |
| tenant_A / LEGAL L1 | `tb_9fa3d61c2d63ee4285ee` | `legal-evidence-check` | LEGAL only + session tools |
| tenant_A / LEGAL L2 | `l2_1ee8b76803c47fec5571` | `legal-evidence-check` | LEGAL only |
| tenant_A / ROBOT_DOG L1 | `tb_9345ba25d7668764fb8a` | `robot-dog-health-check` | ROBOT_DOG only + session tools |
| tenant_A / ROBOT_DOG L2 | `l2_e97c51a415624cc4070a` | `robot-dog-health-check` | ROBOT_DOG only |
| tenant_B / LEGAL L1 | `tb_4a8ee1cd63e0adcad74e` | `legal-evidence-check` | LEGAL only + session tools |
| tenant_B / LEGAL L2 | `l2_8a44c1992bee4a477b17` | `legal-evidence-check` | LEGAL only |

## 外部阻断项

真实 Gateway `agent` RPC 已到达 Qwen provider，但阿里云返回：

```text
HTTP 400 / Arrearage / Access denied, account not in good standing
```

按阿里云官方错误码，这是账号欠费、余额不足或账务状态尚未恢复。需在费用中心恢复账号状态并换用新的有效 Key 后重跑 Phase 3 E2E。此错误不是 OpenClaw fallback；验收脚本不接受 embedded runtime 或伪造 L2 marker 作为通过证据。

## 机密事件与处置

一次临时服务诊断误启 shell xtrace，使模型 Key 出现在本地 Codex 折叠终端输出中。该值未写入 Git、仓库文件、阶段报告或远端服务日志；项目 Gateway token 已立即轮换。模型 Key 必须由仓库所有者在阿里云控制台轮换，然后重新执行配置与验证。

## 诚实边界

本报告证明官方 stable 安装、Gateway 运行、Profile/目录/Skill/Tool 配置隔离和 Adapter 本地契约；由于外部模型账号被拒绝，尚未证明真实 `sessions_send` → L1 → 原生 `sessions_spawn` → 独立 L2 Session 成功。Phase 4 Gateway Mock、Memory、生命周期和恢复也不属于本阶段成功声明。
