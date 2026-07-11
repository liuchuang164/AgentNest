# ADR-0001：L1 使用独立 Agent Profile，L2 使用原生 Sub-agent

- 状态：Accepted
- 日期：2026-07-11
- 决策人：Repository Owner / Architecture Specification

## 背景

目标逻辑架构：

```text
Main Agent → tenant_id + biz_domain Agent → Task Agent
```

OpenClaw 同时提供多 Agent Profile 和 Sub-agent，需要决定如何映射三层模型。

## 候选方案

### 方案 A：L0/L1/L2 全部使用嵌套 Sub-agent

优点：

- 形式接近 `main → depth1 → depth2`。

缺点：

- L1 作为租户业务沙箱缺少独立长期 Profile 语义；
- L1/L2 不同 TTL 难以表达；
- workspace、agentDir、Skill allowlist 和 Tool policy 更适合 Profile 级边界。

### 方案 B：L1 独立 Profile，L2 原生 Sub-agent

优点：

- L1 获得独立 workspace、agentDir、Session Store；
- 可以设置独立 Skill allowlist 和 Tool policy；
- L1 生命周期由 AgentNest 管理；
- L2 使用 `sessions_spawn`，与任务级生命周期匹配；
- 不需要修改 OpenClaw 核心。

缺点：

- “Main 派生 L1”实际由 Control Plane ensure/activate Profile 实现；
- 需要 OpenClaw Adapter 管理 Profile；
- 需要最小 observed-state 检查。

### 方案 C：每个 tenant+biz 独立 OpenClaw Gateway

隔离更强，但 Demo 资源和运维成本过高。

## 决策

选择方案 B：

```text
L0 = 固定 main Agent Profile
L1 = tenant_id + biz_domain 独立 Agent Profile
L2 = L1 通过 sessions_spawn 创建的 native Sub-agent
```

Main Agent 通过 AgentNest Control Plane ensure、activate 和 dispatch L1。

## 约束

- 每个 L1 独立 workspace、agentDir、Session namespace；
- 每个 L1 使用显式 Skill allowlist 和 Tool allowlist；
- L2 默认独立 Session；
- L2 权限只能是 L1 子集；
- L1 24h TTL 由 AgentNest Reaper 管理；
- L2 1h TTL 由 Reaper 管理，OpenClaw auto-archive 只作辅助；
- 第一版不修改 OpenClaw 核心；
- Gateway Mock 使用服务端 `execution_context_id` 校验 Tool/action/resource scope；
- 第一版不实现签名 Capability Token。

## 后果

需要实现：

- Tenant Agent Control Plane；
- OpenClaw Adapter；
- Tenant Runtime Plugin；
- Tenant Capability Profile；
- 服务端 Execution Context；
- Lifecycle Reaper；
- PostgreSQL Persistence/Recovery；
- Data/External Gateway Mock。

不需要实现：

- Redis/MinIO/Kafka/Outbox；
- JWT/PASETO/PKI；
- 分布式锁或多节点 HA。

## 重新评估条件

以下情况可新建 ADR 重新评估：

- OpenClaw stable 原生提供成熟的 tenant/session capability profile；
- 动态 Agent Profile 配置无法可靠使用；
- 单 Gateway 多 Profile 的资源成本无法接受；
- 进入生产化阶段，需要更强进程、网络或密码学隔离。
