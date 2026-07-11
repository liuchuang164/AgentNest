# OpenClaw 兼容基线

## 1. 版本策略

AgentNest 只使用 OpenClaw 官方 stable channel。

仓库文档编写时的版本记录只是参考，实际部署必须重新解析官方最新稳定版。

稳定版必须满足：

- GitHub Release `prerelease=false`，或 npm `latest`；
- 版本字符串不含 `beta`、`alpha`、`rc`、`dev`；
- 安装后 `openclaw --version` 与解析结果一致。

禁止为了获得更方便的实验能力而切换 beta/dev。

官方来源：

- https://github.com/openclaw/openclaw/releases
- https://github.com/openclaw/openclaw
- https://docs.openclaw.ai/

---

## 2. Demo 依赖的公开能力

### 2.1 Multi-agent Profiles

L1 依赖每个配置 Agent 可拥有独立：

```text
workspace
agentDir
Session Store
per-agent config
```

参考：

https://docs.openclaw.ai/concepts/multi-agent

不同 L1 不得复用同一个 `agentDir`。

### 2.2 Per-agent Skill allowlist

依赖实际 stable Schema 中的 per-agent Skill 配置，预期能为每个 L1 设置显式最终 allowlist。

参考：

https://docs.openclaw.ai/tools/skills

如果字段语义与文档不同，以部署版本的 `openclaw config schema` 和 smoke test 为准。

### 2.3 Per-agent Tool policy

依赖每个 Agent 可以配置 Tool allow/deny 或等价能力。

Tool policy 用于限制模型可见性和正常调用路径；Gateway Mock 仍根据服务端 Execution Context 检查 tool/action/resource scope。

### 2.4 Native Sub-agents

L2 依赖：

```text
sessions_spawn
subagent 独立 Session
```

参考：

https://docs.openclaw.ai/tools/subagents

Demo 只需要 L1 派生 L2，一层 native Sub-agent 即可。

### 2.5 Session Store

参考：

https://docs.openclaw.ai/concepts/session

AgentNest 在 OpenClaw Session Store 之外，额外保存：

```text
Session Summary
TaskState
Memory
Trace
Transcript 路径
```

第一版 Transcript 可以保存在本地持久化 volume，不要求 MinIO。

### 2.6 Config reload / Profile management

参考：

https://docs.openclaw.ai/gateway/configuration

AgentNest 应优先使用：

1. 官方 Config API/RPC；
2. 官方 CLI；
3. 结构化 JSON 更新和 reload。

要求：

- 更新前校验实际 Schema；
- 更新后检查 observed Profile；
- 配置失败时不把 Runtime 标记为 ACTIVE；
- 禁止 sed/regex 直接改 JSON。

如果 stable 版无法动态创建 Profile，可采用有限模板 Profile 或受控多实例方案，只要能证明三个 tenant/biz scope 的隔离。

---

## 3. 不依赖的能力

第一版不得依赖：

- beta/dev 才有的 per-conversation capability；
- OpenClaw 未文档化内部函数；
- Prompt 作为租户授权边界；
- auto-archive timer 作为唯一生命周期机制；
- 全局 Plugin Store 自动按 Agent 隔离；
- 未审核的在线 Skill；
- OpenClaw 核心源码 patch。

---

## 4. 兼容性探测

Codex 必须实际运行可用的命令，例如：

```text
openclaw --version
openclaw doctor
openclaw gateway status
openclaw config schema
openclaw agents list
```

并通过 smoke test 确认：

1. Main Profile 可运行；
2. 可以创建或激活第二个 L1 Profile；
3. workspace/agentDir 生效；
4. Skill allowlist 生效；
5. Tool policy 生效；
6. `sessions_spawn` 可用；
7. L2 Session 独立；
8. Session/Transcript 可以定位；
9. OpenClaw 重启后已持久化 Session 信息仍可读取。

探测失败时，应记录实际 stable 版限制并选择最小替代方案，不得偷偷改用预发布版本。

---

## 5. Demo 的隔离组合

第一版验证：

```text
per-agent L1 Profile
+ independent workspace/agentDir/Session namespace
+ explicit Skill allowlist
+ explicit Tool allowlist
+ L2 subset intersection
+ server-side execution_context_id
+ Gateway Mock resource check
+ tenant/biz-scoped PostgreSQL persistence
```

不要求：

```text
signed Capability Token
PKI/mTLS
Redis/MinIO/Kafka/Outbox
multi-node HA
vector database
production audit chain
```

---

## 6. 版本记录

部署结果至少记录：

```text
OpenClaw version
安装来源
解析 stable 的来源
Node version
部署时间
AgentNest commit
```

不要求复杂升级平台。版本变更后重新运行兼容性 smoke、隔离测试和生命周期测试即可。
