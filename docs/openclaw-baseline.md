# OpenClaw 兼容基线

## 1. 基线版本

文档编写日期：`2026-07-11`。

官方 releases 页面当时显示：

```text
v2026.7.1-beta.2  prerelease
v2026.7.1-beta.1  prerelease
v2026.6.11         stable
```

因此仓库初始基线为：

```text
OPENCLAW_CHANNEL=stable
OPENCLAW_VERSION=2026.6.11
```

部署时必须实时重新解析官方最新 stable。如果出现比 2026.6.11 更新的正式 release，以部署时最新稳定版为准，但必须先运行兼容测试。

官方来源：

- Releases: https://github.com/openclaw/openclaw/releases
- Repository: https://github.com/openclaw/openclaw
- Docs: https://docs.openclaw.ai/

---

## 2. 稳定版判定

稳定版必须同时满足：

- GitHub release `prerelease=false`；
- tag 不含 `beta`、`alpha`、`rc`、`dev`；
- npm `latest` 与 release 可交叉验证；
- 安装后 `openclaw --version` 与解析版本一致。

禁止因为 beta 有更方便的 capability feature 就切换 beta。本 Demo 要证明方案建立在稳定公共能力上。

---

## 3. 依赖的官方能力

### 3.1 Multi-agent Profiles

本项目依赖每个配置 Agent 有独立：

- workspace；
- state directory (`agentDir`)；
- session store；
- per-agent config。

参考：

https://docs.openclaw.ai/concepts/multi-agent

关键约束：不得跨 Agent 复用 agentDir。

### 3.2 Per-agent Skill allowlist

依赖：

```text
agents.list[].skills
```

预期语义：

- 省略时继承 defaults；
- 空数组表示无 Skill；
- 非空列表是最终集合，不与 defaults 合并。

参考：

https://docs.openclaw.ai/tools/skills

AgentNest L1 必须使用显式最终 allowlist。

### 3.3 Per-agent Tool/Sandbox policy

依赖：

```text
agents.list[].tools.allow
a gents.list[].tools.deny
agents.list[].sandbox
```

> 实现时删除上面示意中的空格，字段必须以实际 Schema 为准。

Tool policy 只控制 OpenClaw 可见/可调用能力，不替代 Gateway 鉴权。

### 3.4 Native Sub-agents

L2 依赖：

```text
sessions_spawn
sessions_yield
subagents
```

参考：

https://docs.openclaw.ai/tools/subagents

基线行为：

- `sessions_spawn` 非阻塞；
- 默认 context 为 isolated；
- Sub-agent 有独立 Session；
- 模型/思考级别可以继承；
- Tool 可用性受 effective policy 约束；
- auto-archive 默认 60 分钟；
- auto-archive timer 是 best-effort，Gateway 重启可能丢失；
- auto-archive 对 depth 1/2 使用相同配置；
- 本 Demo 仅用 L1 Profile 派生 L2，`maxSpawnDepth=1` 足够。

### 3.5 Session Store

官方 Session 路径：

```text
~/.openclaw/agents/<agentId>/sessions/sessions.json
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

参考：

https://docs.openclaw.ai/concepts/session

AgentNest 会在此基础上额外保存 MinIO Transcript 快照、hash 和数据库索引。

### 3.6 Config hot reload

OpenClaw Gateway 监控配置并支持多数设置热加载，且严格 Schema 校验。

参考：

https://docs.openclaw.ai/gateway/configuration

AgentNest 必须：

- 先校验 Schema；
- 结构化写配置；
- 验证 observed state；
- 处理 reload reject；
- 不假设所有字段都无需 restart；
- 保存 last-known-good。

---

## 4. 不应依赖的能力

第一版不得依赖：

- 仅 beta/dev 存在的 per-conversation capability profiles；
- OpenClaw 未文档化内部模块；
- 具体源码文件路径或私有函数；
- auto-archive timer 作为权威生命周期；
- Prompt 作为授权边界；
- 全局插件存储自动按 Agent 分隔；
- Main Agent OAuth fallback 能提供完全独立认证；
- 未审核 ClawHub Skill。

---

## 5. 兼容性探测

Codex 必须实现自动探测，不要只依赖版本号：

```text
openclaw --version
openclaw config schema
openclaw agents list
openclaw gateway status
```

并通过最小 smoke test 确认：

1. 可以创建第二 Agent Profile；
2. workspace/agentDir 生效；
3. Skill allowlist 生效；
4. Tool policy 生效；
5. sandbox 生效；
6. `sessions_spawn` 可用；
7. child Session 独立；
8. config reload 后 observed state 更新；
9. Session transcript 可定位；
10. restart 后 Session store 可读。

探测失败时，报告实际 Schema 和差异，不允许硬编码绕过。

---

## 6. 升级策略

每次升级 OpenClaw：

1. 解析新 stable；
2. 保存旧版本清单；
3. 在隔离 staging profile 安装；
4. 运行 compatibility smoke；
5. 运行全部隔离负向测试；
6. 运行生命周期/recovery；
7. 检查 config schema diff；
8. 通过后再更新 baseline；
9. 失败则继续使用前一个 stable，并记录阻断原因。

禁止自动追随 `latest` 而不做验证。

---

## 7. 已知边界

OpenClaw 的 per-agent workspace 不是自动的宿主文件系统强隔离；启用 sandbox 才能形成更强边界。Skill allowlist 也不是 shell 授权边界。因此 AgentNest 方案使用：

```text
per-agent Profile
+ explicit Skill allowlist
+ Tool policy
+ agent-scoped sandbox
+ signed Capability Token
+ Gateway resource authorization
+ tenant-scoped persistence
```

这是 Demo 必须验证的纵深防御组合。
