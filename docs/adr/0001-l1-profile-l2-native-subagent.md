# ADR-0001：L1 使用独立 Agent Profile，L2 使用原生 Sub-agent

- 状态：Accepted
- 日期：2026-07-11
- 决策人：Repository Owner / Architecture Specification

## 背景

目标逻辑架构是：

```text
Main Agent → tenant_id + biz_domain Agent → Task Agent
```

OpenClaw 同时提供多 Agent Profile 和嵌套 Sub-agent。需要决定如何映射三层模型。

## 候选方案

### 方案 A：L0/L1/L2 全部使用嵌套 Sub-agent

优点：

- 形式上最接近 `main → depth1 → depth2`；
- OpenClaw 原生支持 `maxSpawnDepth=2`。

缺点：

- L1 作为租户业务沙箱缺少独立长期 Profile 语义；
- depth1/depth2 auto-archive 使用同一配置；
- 难以实现 L1 24h、L2 1h 不同 TTL；
- Skill allowlist、workspace、agentDir 更适合 Agent Profile 级边界；
- L1 不应该只是一次性后台任务 Session。

### 方案 B：L1 独立 Profile，L2 原生 Sub-agent

优点：

- L1 获得独立 workspace、agentDir、Session Store；
- 可设置最终 Skill allowlist、Tool policy、Sandbox；
- L1 生命周期由外部 Control Plane 管理；
- L2 使用 `sessions_spawn`，与任务级生命周期匹配；
- 不需要修改 OpenClaw 核心；
- 稳定版已有所需能力。

缺点：

- “Main 派生 L1”由控制面创建/激活 Profile 实现，不是单纯一次 `sessions_spawn`；
- 需要安全的动态配置 Adapter；
- 需要 reconciliation 保证数据库状态和 OpenClaw observed state 一致。

### 方案 C：每个 tenant+biz 独立 OpenClaw Gateway 进程

优点：隔离更强。

缺点：Demo 资源消耗和运维复杂度过高，不适合首版验证。

## 决策

选择 **方案 B**：

```text
L0 = 固定 main Agent Profile
L1 = tenant_id + biz_domain 独立 Agent Profile
L2 = L1 通过 sessions_spawn 创建的 native Sub-agent
```

Main Agent 通过 AgentNest Control Plane 的 Tool/API ensure、activate、dispatch L1。

## 约束

- 每个 L1 独立 workspace、agentDir、Session Store；
- 每个 L1 显式 Skill allowlist、Tool policy、Sandbox；
- L2 使用 isolated context；
- L2 权限为 L1 子集；
- L1 24h TTL 由数据库 Reaper 管理；
- L2 1h TTL 由 Reaper 管理，OpenClaw auto-archive 仅辅助；
- 不修改 OpenClaw 核心；
- Gateway 使用 Capability Token 强校验。

## 后果

需要实现：

- Tenant Agent Control Plane；
- OpenClaw Config Adapter；
- Tenant Runtime Plugin；
- Capability Registry/Snapshot/Token；
- Lifecycle Reaper；
- Persistence/Recovery；
- Data/External Gateway Mock。

## 重新评估条件

以下情况可重新评估，但必须新建 ADR：

- OpenClaw stable 原生提供成熟的 per-session capability profile 和不同深度 TTL；
- 动态 Agent Profile 配置无法可靠热加载；
- 单 Gateway 多 Profile 资源成本无法接受；
- 生产合规要求每租户独立进程/容器。
