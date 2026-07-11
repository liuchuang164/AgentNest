# AGENTS.md — AgentNest Codex 最高优先级约束

本文件适用于整个仓库。Codex、OpenClaw 内部编码 Agent、其他自动化开发 Agent 在修改任何文件、连接远端服务器或运行测试前，必须完整阅读并遵守本文件。

规范关键词：**必须（MUST）**、**禁止（MUST NOT）**、**应该（SHOULD）**。

---

## 1. 唯一任务目标

构建一个可部署、可自动验证的 OpenClaw 三层多租户 Agent Demo：

```text
L0 Main Agent
  └─ L1 TenantBizAgent (tenant_id + biz_domain)
       └─ L2 TaskAgent
```

验证重点不是模型回答质量，而是以下技术属性：

1. `tenant_id + biz_domain` 的运行态、Skill、Tool、Memory、Session 和 Trace 隔离；
2. L2 权限只能是 L1 权限的子集，禁止权限提升；
3. L1/L2 运行态可超时卸载；
4. 卸载前 Session、Memory、Trace、TaskState 可持久化；
5. 后续请求可创建新的运行实例并恢复必要状态；
6. Data/External Gateway Mock 可在模型或插件越权时进行硬拒绝；
7. OpenClaw 和 AgentNest 进程重启后，状态可恢复且不会出现幽灵 Agent。

---

## 2. 不可改变的架构决策

### 2.1 L0

- L0 是固定的 OpenClaw `main` Agent Profile。
- L0 仅负责请求解析、租户业务路由、L1 ensure/activate/dispatch 和平台级 Trace。
- L0 禁止直接持有庭策、机器狗等业务 Skill。
- L0 禁止直接调用业务 Data Tool 或 External Tool。

### 2.2 L1

- L1 的逻辑唯一键必须是：

```text
(tenant_id, biz_domain)
```

- L1 必须映射为独立的 OpenClaw Agent Profile，而不是只靠 Prompt 模拟租户。
- 每个 L1 必须拥有独立且不可复用的：
  - `workspace`
  - `agentDir`
  - Session Store
  - Skill allowlist
  - Tool allow/deny policy
  - Memory namespace
  - Capability Snapshot
- 禁止两个 L1 共用同一个 `agentDir`。
- L1 的 OpenClaw `agentId` 必须由规范化的 `tenant_id + biz_domain` 稳定派生，不能把原始租户名直接拼进文件路径。
- 稳定 ID 推荐：

```text
tb_<sha256(normalized_tenant_id + ":" + normalized_biz_domain)[0:20]>
```

### 2.3 L2

- L2 必须由 L1 使用 OpenClaw 原生 `sessions_spawn` 创建。
- 默认使用 `context: "isolated"`，只有明确需要父 Transcript 时才允许 `fork`。
- L2 必须有独立 Session 和 `task_id`。
- L2 的能力必须满足：

```text
L2.skills       ⊆ L1.skills
L2.tools        ⊆ L1.tools
L2.tool_actions ⊆ L1.tool_actions
L2.memory_scope ⊆ L1.memory_scope
L2.data_scope   ⊆ L1.data_scope
```

- 禁止任何形式的 capability union、默认补全或“缺少权限时临时开放”。
- 实际 L2 能力必须按交集计算：

```text
L2_effective = L1_snapshot ∩ task_template ∩ current_tenant_policy
```

---

## 3. OpenClaw 基线约束

- 只能部署官方 **stable** channel。
- 禁止使用 `beta`、`dev`、RC、预发布 tag 或未经发布的 `main` 分支特性。
- 当前文档基线为 `v2026.6.11`；部署前必须重新验证官方最新稳定版。
- 必须记录：
  - 安装时间；
  - OpenClaw version；
  - Git tag/commit（可获取时）；
  - npm dist-tag 或 release URL；
  - Node 版本；
  - OpenClaw 配置 Schema hash。
- 远端推荐 Node 24；最低不得低于 OpenClaw 当前稳定版官方要求。
- 安装后必须运行并保存脱敏结果：

```bash
openclaw --version
openclaw doctor
openclaw gateway status
openclaw config schema
```

- 优先使用插件、配置适配器和独立控制面实现功能。第一版 Demo 禁止 fork 或直接修改 OpenClaw 核心，除非：
  1. 已用最小复现证明插件/公开接口无法实现；
  2. 在 `docs/adr/` 新增 ADR；
  3. 明确列出补丁、风险和升级成本；
  4. 保留可关闭的 feature flag。

---

## 4. 技术栈和工程约束

除非 ADR 明确批准，使用：

- Node.js 24；
- TypeScript，`strict: true`；
- pnpm workspace；
- Fastify 或同等级轻量 HTTP 框架；
- PostgreSQL 16：权威状态、Capability、TaskState、Trace 索引；
- Redis 7：分布式锁、心跳、TTL、幂等与短期 Runtime Registry；
- MinIO：大 Transcript、快照、Artifact；
- Vitest：单元/集成测试；
- Testcontainers：本地集成测试（可用时）；
- Docker Compose：远端 Demo 部署；
- OpenAPI 3.1 + JSON Schema：接口契约。

工程要求：

- 所有 TypeScript 禁止 `any`，确需使用时必须局部注释原因；
- 所有外部输入必须 Schema 校验；
- 所有状态变更必须可重试且幂等；
- 所有时间使用 UTC；
- TTL 必须可配置并支持测试时钟，不允许测试真实等待 1 小时/24 小时；
- 所有关键状态机必须使用显式 enum，禁止用随意字符串；
- 生产路径禁止内存数据库或进程内 Map 作为唯一真相源；
- Runtime cache 可以在内存/Redis，但 PostgreSQL 是权威状态源；
- 关键写操作必须使用事务或 Outbox，不能出现数据库已提交而 Trace 永久缺失的静默失败。

---

## 5. Capability 安全模型

### 5.1 Capability Snapshot

L1 创建时必须生成不可变 Snapshot，至少包含：

```text
snapshot_id
policy_version
tenant_id
biz_domain
skills + versions
tools + actions
memory_scopes
data_scopes
sandbox_policy
model_policy
lifecycle_policy
created_at
```

- Snapshot 用于审计和当前运行实例授权。
- 新运行实例必须按最新租户策略重新解析 Snapshot。
- 恢复历史 Session 不得复活已撤销权限。

### 5.2 Capability Token

每个 L2 必须获得短期、签名、不可扩大权限的 Capability Token。

Token 至少绑定：

```text
token_id
parent_token_id
snapshot_id
runtime_instance_id
agent_id
session_id
task_id
tenant_id
biz_domain
allowed_tools + actions
memory_scope
data_scope
issued_at
expires_at
nonce
```

要求：

- 使用非对称签名或独立 HMAC 密钥；
- 密钥不能写入仓库；
- Gateway 必须校验签名、过期、父子关系、租户、业务域、Agent、Session、Task 和 Tool action；
- 模型提供的 `tenant_id`、`biz_domain`、`user_id` 不能作为可信身份源；
- 可信上下文必须由控制面签发并由 Gateway 校验；
- 拒绝必须 fail closed。

### 5.3 双重/三重校验

Tool 隔离不能只依赖 OpenClaw 的 Tool 可见性：

```text
OpenClaw Agent Tool Policy
  → Tenant Runtime Plugin Capability 检查
  → Data/External Gateway Capability Token 检查
  → 资源归属与操作权限检查
```

任一层失败，调用都必须被拒绝并写审计。

---

## 6. Skill、Tool、Memory 隔离约束

### 6.1 Skill

- L1 必须设置非空的 `agents.list[].skills` 最终 allowlist；需要无 Skill 时使用空数组。
- 禁止依赖全局默认 Skill 自动合并。
- 每个租户业务 workspace 只能 materialize 被授权 Skill。
- 禁止从未审核的 ClawHub 安装任意 Skill。
- Demo Skill 必须随仓库版本化并带 hash。
- Skill allowlist 不是 shell 安全边界；有 `exec` 时必须另外 Sandbox。

### 6.2 Tool

- L0、L1、L2 的 Tool policy 必须分别配置。
- Tool 定义可以全局注册，但对模型可见的 Tool Registry View 必须按当前 L1/L2 Capability 过滤。
- Tool 调用必须携带不可伪造的运行上下文；禁止从静态插件配置注入固定 `tenantId` 作为生产身份。
- Gateway 必须对 action 级权限进行校验，不能只校验 tool_name。

### 6.3 Memory

- Memory 查询必须强制携带并过滤：

```text
tenant_id + biz_domain + visibility + resource_scope
```

- 禁止先全局向量召回再在应用层过滤。
- 禁止跨租户 Memory fallback。
- 禁止配置跨 Agent QMD extraCollections，除非测试专门验证共享且经过 ADR 批准。
- 每个 L1 的 Memory Wiki/向量 namespace 必须 agent scoped 或显式 tenant-business scoped。
- 大文本、Transcript 和 Tool 原始结果放 MinIO；数据库仅保存摘要、索引、hash 与 URI。

---

## 7. 生命周期语义

“销毁”在本项目中指 **卸载运行态（runtime unload/archive）**，不是删除历史数据。

### L1

默认：

```text
idle_ttl = 24h
```

卸载前必须满足：

- 无活动 L2；
- 无 `RUNNING`、`WAITING_TOOL`、`PERSISTING` 任务；
- 成功获取租户业务 Agent 分布式锁；
- 成功完成最终 checkpoint。

### L2

默认：

```text
idle_ttl = 1h
```

- 任务完成后立即 checkpoint；
- 等待用户输入时应尽快冻结，不应占用内存等待；
- OpenClaw 原生 Sub-agent auto-archive 只能作为辅助；由于其 timer 在 Gateway 重启后可能丢失，数据库驱动 Reaper 是必需项。

### 必须持久化

卸载前至少持久化：

```text
Session Summary
Transcript URI + hash
Memory delta
Trace events
TaskState/current_step
Tool call records
Intermediate artifact references
Capability Snapshot reference
last_active_at
```

### 恢复

- `logical_agent_id` 稳定；
- `runtime_instance_id` 每次重建都必须变化；
- 默认新建 Session，不把完整历史 Transcript 无限制重新注入模型；
- 恢复仅注入 Session Summary、未完成 TaskState、必要 Memory 和 Artifact 引用；
- 必须记录 `restored_from_runtime_instance_id`。

---

## 8. 数据模型不可缺失字段

所有 Agent、Session、Task、Memory、Trace、Tool Call 表或事件必须可关联：

```text
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
agent_id
session_id
task_id
trace_id
capability_snapshot_id
created_at
```

非适用字段可为空，但不能从模型中删除。

所有租户业务唯一约束必须以 `tenant_id + biz_domain` 为前缀。任何只以 `task_id`、`session_id` 或 `resource_id` 做查询的 DAO 都必须被测试阻止。

---

## 9. API 约束

必须实现并文档化：

```text
POST /api/v1/tasks
GET  /api/v1/tasks/:taskId
GET  /api/v1/agents/:logicalAgentId
POST /api/v1/admin/agents/:logicalAgentId/checkpoint
POST /api/v1/admin/agents/:logicalAgentId/unload
POST /api/v1/admin/reaper/run-once
POST /api/v1/admin/test-clock/advance   # 仅 test/demo profile
GET  /health/live
GET  /health/ready
GET  /metrics
```

- 所有请求必须有 `request_id`；
- 返回必须有 `trace_id`；
- 写接口必须支持 `idempotency_key`；
- Admin 和 test-clock 接口默认关闭，不得暴露公网；
- OpenAPI 文件必须进入版本控制并通过兼容性测试。

---

## 10. 云服务器和 config.txt 约束

仓库是公开的。

- `config.txt` 是本地只读机密文件，禁止提交、复制到 Artifact、写入日志或回显。
- Codex 可以读取 `config.txt` 以建立 SSH 和部署，但必须对所有输出脱敏。
- 如果 `config.txt` 不存在或字段缺失，停止部署并给出缺失字段，不得猜测。
- 禁止修改或删除用户提供的 `config.txt`。
- 禁止在命令行参数中直接传密码；优先 SSH key、环境变量文件或 stdin。
- 禁止把私钥内容写入远端工程目录。
- 所有远端操作限制在配置指定的 `REMOTE_WORKDIR`；禁止清理未知目录、重装整机、修改防火墙全局策略或删除非本项目容器。
- 任何 `rm -rf` 必须经过路径规范化和 allowlist 检查。
- Gateway 不得裸露公网；默认仅监听 loopback 或 Docker 私网，通过 SSH tunnel 访问。
- 对外 Demo API 必须有认证；Admin API 必须仅 loopback/私网。

---

## 11. 开发阶段与强制 Gate

按 `CODEX_TASK.md` 顺序开发。每个阶段完成前必须：

1. 代码、测试和文档同步提交；
2. 所有新增接口有 Schema；
3. lint、typecheck、unit test 通过；
4. 生成阶段报告到 `artifacts/reports/`（目录不提交大日志，只提交脱敏摘要）；
5. 不得用跳过测试、硬编码成功响应或伪造日志通过 Gate。

禁止在核心隔离测试未完成前宣称 Demo 完成。

---

## 12. 测试底线

至少必须覆盖：

- Unit：ID 派生、Capability 交集、Token 验签、TTL、状态机；
- Contract：OpenAPI/JSON Schema；
- Integration：PostgreSQL、Redis、MinIO、Gateway Mock；
- OpenClaw E2E：L0→L1→L2；
- Negative isolation：跨租户、跨业务、跨资源、越权 Tool action；
- Lifecycle：L1 24h、L2 1h，使用 fake clock；
- Recovery：Control Plane 重启、OpenClaw 重启、Reaper 重启；
- Concurrency：同一 L1 并发 ensure 只创建一个逻辑实例；
- Idempotency：同一任务重复提交不重复执行；
- Failure injection：持久化失败时禁止卸载、MinIO 不可用、Redis 锁过期、Gateway 超时；
- Secret scan：仓库和测试 Artifact 不得包含 config.txt 内容。

任何安全测试必须同时验证：

```text
HTTP/Tool 返回拒绝
业务副作用未发生
审计事件已写入
Trace 可关联
```

---

## 13. 完成定义

只有同时满足以下条件才能标记完成：

- `docs/acceptance-checklist.md` 全部打勾并附证据路径；
- 一键远端部署脚本可在干净服务器重复执行；
- 一键验证脚本退出码为 0；
- 测试报告包含成功与故意失败的隔离案例；
- 远端进程重启后恢复测试通过；
- 实际 OpenClaw 版本为稳定版；
- 无 beta/dev 依赖；
- 无机密泄露；
- 无跨租户数据、Memory、Skill、Tool 可见性；
- 未修改 OpenClaw 核心，或已存在经批准 ADR 和可重放补丁。

---

## 14. 变更本约束

任何弱化本文件中租户隔离、权限交集、持久化或测试要求的修改，都必须由仓库所有者明确批准。Codex 禁止自行删除、绕过或模糊化这些约束。
