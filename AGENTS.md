# AGENTS.md — AgentNest Demo 最高优先级约束

本文件适用于整个仓库。Codex 或其他开发 Agent 在修改代码、连接远端服务器或运行部署前，必须先阅读本文件。

本项目是一个**技术验证 Demo**，目标是尽快证明三层 Agent、租户业务隔离、生命周期卸载和状态恢复可行。不要把它扩展成生产级零信任、金融级审计或高可用平台。

规范关键词：**必须（MUST）**、**禁止（MUST NOT）**、**应该（SHOULD）**。

---

## 1. 唯一任务目标

实现并验证：

```text
L0 Main Agent
  └─ L1 TenantBizAgent (tenant_id + biz_domain)
       └─ L2 TaskAgent
```

Demo 必须证明：

1. 相同 `tenant_id + biz_domain` 复用同一个逻辑 L1；
2. 不同租户或业务域使用独立 L1 Profile、workspace、agentDir、Session 和 Memory namespace；
3. L1 使用显式 Skill allowlist 和 Tool allowlist；
4. L2 只能获得 L1 权限的子集；
5. L1/L2 可按 TTL 卸载运行态；
6. 卸载前 Session Summary、Memory、Trace 和 TaskState 可持久化；
7. 后续请求可以创建新的运行实例并恢复必要状态；
8. 至少一条任务真实经过 OpenClaw 的 L0 → L1 → `sessions_spawn` → L2 链路。

模型回答质量不是主要验收指标。

---

## 2. 不可改变的架构决策

### 2.1 L0 Main Agent

- L0 是固定的 OpenClaw `main` Agent Profile；
- 仅负责解析 `tenant_id`、`biz_domain`、`task_type`，并 ensure/dispatch L1；
- 不加载 LEGAL、ROBOT_DOG 等具体业务 Skill；
- 不直接调用业务 Tool。

### 2.2 L1 TenantBizAgent

- 唯一逻辑键必须是 `(tenant_id, biz_domain)`；
- 必须映射为独立 OpenClaw Agent Profile，不能只靠 Prompt 标注租户；
- 每个 L1 必须有独立：
  - `workspace`；
  - `agentDir`；
  - Session namespace/store；
  - Skill allowlist；
  - Tool allowlist；
  - Memory namespace；
- 两个 L1 禁止共用同一个 `agentDir`；
- 目录使用稳定 hash ID，禁止把未校验的原始租户字符串直接拼进路径；
- 推荐逻辑 ID：

```text
tb_<sha256(normalized_tenant_id + ":" + normalized_biz_domain)[0:20]>
```

### 2.3 L2 TaskAgent

- 必须由 L1 使用 OpenClaw 原生 `sessions_spawn` 创建；
- 默认独立 Session；
- 必须绑定 `task_id`；
- 能力必须满足：

```text
L2.skills       ⊆ L1.skills
L2.tools        ⊆ L1.tools
L2.tool_actions ⊆ L1.tool_actions
L2.memory_scope ⊆ L1.memory_scope
```

- 子 Agent 只能收窄权限，不能自动补全或临时扩大权限；
- Demo 使用普通集合交集和包含检查即可，不需要设计通用授权语言。

---

## 3. Demo 必需的安全基线

安全只覆盖完成 Demo 所需的最小边界。

### 3.1 租户业务 Scope

以下数据必须始终关联：

```text
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
```

所有 Memory、Task、Trace 和 Demo 业务资源查询必须在 SQL/Repository 层带 `tenant_id + biz_domain`，不能先全量查询再在应用层过滤。

### 3.2 Skill 与 Tool 可见性

- L1 使用显式 Skill/Tool allowlist；
- L2 的 allowlist 由 L1 allowlist 与任务模板取交集；
- LEGAL Agent 看不到 ROBOT_DOG Skill/Tool，反之亦然；
- Prompt 中写出未授权 Skill 或 Tool 名称不能让它出现。

### 3.3 可信执行上下文

Demo 不实现 JWT/PASETO Capability Token。

控制面创建一个服务端保存的 `execution_context`，至少包含：

```text
execution_context_id
tenant_id
biz_domain
logical_agent_id
runtime_instance_id
session_id
task_id
allowed_skills
allowed_tools + actions
resource_scope
expires_at
```

规则：

- `execution_context_id` 使用随机 UUID；
- OpenClaw Plugin/Adapter 只传 `execution_context_id` 给 Gateway Mock；
- Gateway Mock 必须从控制面或 PostgreSQL读取权威上下文；
- Gateway 不得相信模型或请求 body 自报的 tenant、biz、tool/action 权限；
- Gateway 校验 tool/action 和资源归属后再执行；
- 未知、过期或 scope 不匹配的 context 默认拒绝。

这足以验证 Demo 隔离，不需要签名 Token、nonce、revocation、PKI 或重放协议。

### 3.4 Memory 隔离

每条 Memory 至少保存：

```text
tenant_id
biz_domain
logical_agent_id
session_id
task_id
memory_type
content
```

查询必须带 `tenant_id + biz_domain`。第一版 Demo 使用 PostgreSQL 文本查询即可，不要求向量数据库。

### 3.5 文件路径

- workspace/agentDir/session 路径只能从稳定逻辑 ID 派生；
- 路径必须规范化并确认仍在项目运行根目录内；
- 拒绝 `..`、绝对路径和 symlink escape；
- 不允许两个租户业务共享写目录。

### 3.6 基础机密保护

- `config.txt`、`.env`、SSH 私钥、模型/API Key 禁止提交 Git；
- 日志不得输出密码、Token、私钥或完整连接串；
- OpenClaw、PostgreSQL 和 Admin/Test API 默认只监听 loopback 或 Docker 私网；
- 远端操作只能位于 `REMOTE_WORKDIR` 和本项目容器/目录内。

---

## 4. 明确不做的安全与平台能力

第一版 Demo **禁止主动扩展**以下内容，除非它们真实阻塞三层 Agent 验证并先写简短 ADR：

- JWT/JWS/PASETO Capability Token；
- nonce、jti、Token revoke、Token rotation；
- PKI、mTLS、零信任网络；
- OAuth、完整 RBAC、组织级 IAM；
- Kafka、事件总线、Outbox；
- Redis 分布式锁、集群心跳、多节点 HA；
- MinIO 对象存储；
- 向量数据库与语义 Memory；
- 审计 hash chain、不可抵赖系统；
- Kubernetes、多区域、灾备；
- 生产计费、限额和配额系统；
- 全面 SSRF/WAF/供应链安全平台；
- 大规模性能压测。

Demo 可以记录简单 `ALLOW/DENY` Trace，但不建设生产审计平台。

---

## 5. 最小技术栈

除非实现中确认 OpenClaw stable 有硬性要求，使用：

- Node.js 24；
- TypeScript `strict: true`；
- pnpm workspace；
- Fastify；
- PostgreSQL 16；
- Vitest；
- Docker Compose；
- OpenAPI/JSON Schema 只覆盖对外 API 和核心运行上下文。

允许：

- 进程内 `Map` 作为可重建 Runtime cache；
- PostgreSQL 作为权威状态源；
- 本地持久化 volume 保存 Transcript/Snapshot 文件。

不要求 Redis、MinIO、Testcontainers、消息队列或分布式协调。

工程要求：

- 外部 HTTP 输入必须校验；
- 时间统一使用 UTC；
- TTL 可通过环境变量配置；
- 生命周期测试使用 fake clock，禁止真实等待 1 小时/24 小时；
- 状态机使用显式 enum；
- 关键错误不能吞掉后返回 success；
- 不得伪造测试输出。

---

## 6. 生命周期

“销毁”指卸载运行态，不删除历史数据。

默认：

```text
L1 idle TTL = 86400 秒（24h）
L2 idle TTL = 3600 秒（1h）
```

### L2 卸载前

至少保存：

- TaskState；
- Session Summary；
- Memory；
- Trace；
- 最终或中间结果。

### L1 卸载前

必须：

- 没有运行中的 L2；
- 保存 Session Summary、Memory、Trace 和当前能力配置摘要；
- 持久化成功后再从 Runtime Registry/OpenClaw 活跃配置中卸载。

持久化失败时，不得把状态标记为 `UNLOADED`。

恢复时：

- `logical_agent_id` 保持不变；
- `runtime_instance_id` 必须变化；
- 默认创建新 Session；
- 恢复摘要、Memory、Trace 索引和未完成 TaskState；
- 不自动把完整历史 Transcript 注入模型。

---

## 7. OpenClaw 基线

- 只使用官方 stable channel；
- 禁止 beta、alpha、RC、dev 和未发布 `main` 特性；
- 部署前查询并记录实际稳定版本；
- 优先使用官方配置、插件、CLI 或 RPC；
- 第一版不修改 OpenClaw 核心源码；
- 如果 stable 版不支持动态 Profile，可采用结构化配置 reload、有限模板 Profile 或受控的多实例方式，选择最小可运行方案并记录限制。

---

## 8. Demo 数据与最小测试

至少准备：

```text
tenant_A + LEGAL
tenant_A + ROBOT_DOG
tenant_B + LEGAL
```

两个 LEGAL 租户都创建 `case_001`。

必须自动验证：

1. 同 scope L1 创建与复用；
2. 不同 scope 的 Profile、workspace、Session 隔离；
3. Skill 隔离；
4. Tool/action 隔离；
5. Memory 隔离；
6. L2 权限子集；
7. L2 TTL 卸载与恢复数据存在；
8. L1 TTL 卸载与重新创建；
9. `logical_agent_id` 稳定、`runtime_instance_id` 变化；
10. 至少一条真实 OpenClaw 三层链路成功。

负向 Tool 测试至少验证：

```text
调用被拒绝
目标业务数据没有变化
Trace 记录 DENY 原因
```

不要求完整 Audit 系统或密码学证明。

---

## 9. API 与部署底线

至少实现：

```text
POST /api/tasks
GET  /api/tasks/:taskId
GET  /api/agents
GET  /api/agents/:logicalAgentId
GET  /api/agents/:logicalAgentId/memories
POST /api/admin/reaper/run
POST /api/admin/clock/advance   # 仅 demo/test
GET  /health
```

- Admin/Test 接口只绑定 loopback/私网；
- `config.txt` 不存在时只完成本地开发并报告缺失字段；
- 部署脚本应可重复运行，只操作本项目资源；
- 最终提供 `pnpm demo:deploy` 和 `pnpm demo:verify`。

---

## 10. 工作方式与完成定义

按 `CODEX_TASK.md` 阶段执行。每个阶段：

1. 给出简短计划；
2. 实际修改代码；
3. 运行 lint、typecheck 和相关测试；
4. 修复失败；
5. 提交清晰 commit；
6. 更新 Issue #1。

Demo 完成条件：

- 三层 OpenClaw 链路真实运行；
- 三个 tenant/biz scope 的 Skill、Tool、Memory、Session 隔离测试通过；
- L1/L2 生命周期和恢复测试通过；
- 云端部署可重复执行；
- 没有提交机密；
- 文档清楚区分 Demo 方案和未来生产化建议。

任何新增复杂安全机制都必须先回答：**它是否直接用于证明上述 Demo 目标？** 如果不是，留到“生产化建议”，不要实现。

---

## 11. 独立工作流路由：Hermes

本仓库可以在独立分支开发 Hermes 认知编排服务，但必须与本文件前述 OpenClaw
三层 Demo 工作流隔离。

当任务明确要求开发 Hermes，且变更位于：

```text
apps/hermes/**
docs/hermes/**
HERMES_CODEX_TASK.md
```

必须先完整阅读：

```text
apps/hermes/AGENTS.md
HERMES_CODEX_TASK.md
docs/hermes/README.md 及其列出的全部约束
```

在 `apps/hermes/**` 内，嵌套 `AGENTS.md` 对 Hermes 专属边界具有更高优先级。
根目录的机密保护、测试真实性、稳定技术栈和 Git 安全规则继续生效。

Hermes 工作流只允许实现任务理解、SOP、DAG、执行策略、质量验收和有界重规划。
禁止借 Hermes 任务修改或实现：

```text
OpenClaw Runtime / Profile / Session / sessions_spawn
Agent Control Plane 的资源、配额、限流、队列和生命周期
Tool/Data/External/File Gateway
业务 Skill 或 Tool Handler
```

Hermes 工作不得更新 OpenClaw Demo Issue #1；必须使用独立 Issue/PR。若任务没有
明确指定 Hermes，则仍按本文件第 1—10 节和 `CODEX_TASK.md` 执行 OpenClaw Demo。
