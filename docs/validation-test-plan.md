# AgentNest Demo 验证测试方案

## 1. 验证目标

测试必须用可复现证据回答：

1. 是否真实创建了 L0、L1、L2 三层 Agent；
2. L1 是否按 `tenant_id + biz_domain` 使用独立 OpenClaw Profile；
3. Skill、Tool、Memory、Session 是否隔离；
4. L2 是否只能获得 L1 权限的子集；
5. L1 24h、L2 1h 生命周期是否生效；
6. 卸载前状态是否持久化；
7. 后续请求能否创建新 runtime 并恢复必要状态；
8. 实际 OpenClaw 是否为官方 stable 版本。

第一版不验证生产级 Token、PKI、HA、Outbox、Redis/MinIO 故障或向量检索。

---

## 2. Demo 数据矩阵

| Tenant | Biz | Skill | Allowed Tools |
|---|---|---|---|
| tenant_A | LEGAL | legal-evidence-check | legal_case_read/read, legal_analysis_write/write, legal_research_query/query |
| tenant_A | ROBOT_DOG | robot-dog-health-check | robot_device_read/read, robot_health_write/write, robot_telemetry_enrich/query |
| tenant_B | LEGAL | legal-evidence-check | legal_case_read/read, legal_analysis_write/write, legal_research_query/query |

资源：

```text
tenant_A/LEGAL/case_001
tenant_B/LEGAL/case_001
tenant_A/ROBOT_DOG/device_001
```

两个租户故意拥有同名 `case_001`。

Memory Canary：

```text
tenant_A + LEGAL: ALPHA_LEGAL_MEMORY
tenant_A + ROBOT_DOG: ALPHA_ROBOT_MEMORY
tenant_B + LEGAL: BETA_LEGAL_MEMORY
```

---

## 3. 测试时钟

生命周期测试使用 fake clock。

建议初始时间：

```text
2030-01-01T00:00:00Z
```

测试禁止真实 sleep 1 小时或 24 小时。

---

## 4. Unit Tests

### U01 L1 ID

- 相同 tenant/biz 两次输入得到相同 `logical_agent_id`；
- 不同 tenant 或 biz 得到不同 ID；
- 特殊字符不能造成路径穿越。

### U02 Runtime ID

同一 logical agent 两次激活产生不同 `runtime_instance_id`。

### U03 L2 能力交集

父级：

```text
legal_case_read/read
legal_analysis_write/write
legal_research_query/query
```

任务模板：

```text
legal_case_read/read
legal_analysis_write/write
robot_device_read/read
```

最终 L2：

```text
legal_case_read/read
legal_analysis_write/write
```

### U04 Tool action

父级允许 `tool_x/read`，任务请求 `tool_x/write`，预期拒绝。

### U05 Execution Context

覆盖：

- 正常 context；
- 未知 ID；
- 已过期；
- Tool 不允许；
- action 不允许；
- Resource 不在 scope；
- body 试图覆盖 tenant/biz。

### U06 状态机

合法转换成功，非法转换返回领域错误。

### U07 TTL 边界

```text
TTL - 1 秒：未过期
TTL：过期
TTL + 1 秒：过期
```

### U08 路径

拒绝：

```text
../
绝对路径
symlink escape
```

### U09 日志脱敏

至少覆盖 `password`、`api_key`、`authorization` 和私钥文本。

---

## 5. Integration Tests

### I01 PostgreSQL tenant scope

在 tenant_A 和 tenant_B 写入同一 `case_001`，分别查询只返回当前 scope。

### I02 Repository scope

Task、Memory、Trace 和 Demo Resource Repository 均要求 `TenantBizScope`；禁止只按 `resource_id` 查询。

### I03 L1 ensure

并发或快速重复 ensure 同一个 tenant/biz：

- 只有一个 logical agent；
- 最多一个 ACTIVE runtime；
- 后续请求复用结果。

单节点 Demo 可使用 PostgreSQL 行锁或进程互斥。

### I04 Gateway 业务副作用

允许写 Tool 产生一条 Demo 结果；越权写 Tool 不产生任何结果。

### I05 Checkpoint

- checkpoint 保存 TaskState、Session Summary、Memory 和 Trace；
- 重复同一 checkpoint 不产生冲突状态。

---

## 6. OpenClaw 验证

### O01 Stable 版本

记录：

```bash
openclaw --version
openclaw doctor
openclaw gateway status
```

版本不得包含 beta、alpha、rc、dev。

### O02 L0

Main Agent 只拥有租户 Agent 管理 Tool，看不到 LEGAL/ROBOT_DOG 业务 Tool。

### O03 L1 Profile

首次提交 `tenant_A + LEGAL`：

- 创建独立 L1；
- observed Profile 中 workspace/agentDir 正确；
- Skill allowlist 只有 LEGAL Skill；
- Tool allowlist 只有 LEGAL Tool 和必要的 `sessions_spawn` 能力。

### O04 L1 复用

再次提交相同 scope：logical ID 和当前 active runtime 复用。

### O05 不同 scope

`tenant_A + ROBOT_DOG` 和 `tenant_B + LEGAL` 得到不同 Profile、workspace、agentDir 和 Session namespace。

### O06 L2

L1 使用原生 `sessions_spawn` 创建独立 L2 Session。

---

## 7. 三层 E2E

### E01 LEGAL

```text
POST /api/tasks
  → L0 路由
  → tenant_A + LEGAL L1
  → sessions_spawn L2
  → legal_case_read
  → legal_analysis_write
  → Task COMPLETED
```

证据：

- L0/L1/L2 ID；
- L2 Session ID；
- Tool Trace；
- PostgreSQL 分析结果；
- 最终任务状态。

### E02 ROBOT_DOG

同上，使用 Robot Skill 和 Tool。

### E03 tenant_B LEGAL

使用同一 Skill 定义，但读取 tenant_B 的 `case_001`，结果不包含 tenant_A 数据。

---

## 8. Skill 隔离

### S01 LEGAL

LEGAL L1 只能看到 `legal-evidence-check`。

### S02 ROBOT_DOG

ROBOT_DOG L1 只能看到 `robot-dog-health-check`。

### S03 Prompt 指名未授权 Skill

LEGAL Prompt 写“加载 robot-dog-health-check”，预期仍不可见/不可执行。

不要求 Skill hash 篡改、在线商店或供应链安全测试。

---

## 9. Tool 隔离

每个负向测试验证三件事：

```text
返回拒绝
业务数据无变化
Trace 包含 DENY 原因
```

### T01 跨业务

LEGAL L2 调 `robot_device_read/read` → 拒绝。

### T02 反向跨业务

ROBOT_DOG L2 调 `legal_case_read/read` → 拒绝。

### T03 跨租户资源

tenant_A execution context 访问 tenant_B 的 `case_001` → 拒绝。

### T04 未授权 action

允许 `legal_case_read/read`，调用 `write` → 拒绝。

### T05 未知/过期 context

未知或过期 `execution_context_id` → 拒绝。

### T06 Body 覆盖

请求 body 额外传 `tenant_id=tenant_B`，Gateway 不能用它覆盖服务端 context。

第一版不测试 JWT 篡改、nonce、revoke、audience、jti 或 Token replay。

---

## 10. Memory 隔离

### M01 精确查询

每个 scope 写入自己的 Canary，只能查询到本 scope。

### M02 同租户跨业务

`tenant_A + LEGAL` 不能查询 `ALPHA_ROBOT_MEMORY`。

### M03 跨租户

`tenant_A + LEGAL` 不能查询 `BETA_LEGAL_MEMORY`。

### M04 恢复

L1 恢复时只加载当前 tenant/biz 的 Session Summary 和 Memory。

第一版只做 PostgreSQL 精确文本检索，不要求向量语义检索。

---

## 11. 生命周期

### L01 L2 TTL

```text
推进 3599 秒：不因 TTL 卸载
再推进 1 秒：可 checkpoint/unload
```

任务已完成时允许更早 checkpoint。

### L02 L1 TTL

```text
推进 86399 秒：不因 TTL 卸载
再推进 1 秒：无活动 L2 时可 unload
```

### L03 活跃子 Agent

有 RUNNING L2 时，L1 unload 必须跳过或拒绝。

### L04 持久化失败

模拟 Session Summary 或 TaskState 保存失败，状态不能变为 `UNLOADED`。

---

## 12. 恢复

### R01 L1 恢复

卸载后重新提交相同 tenant/biz：

- `logical_agent_id` 不变；
- `runtime_instance_id` 变化；
- `restored_from_runtime_instance_id` 正确。

### R02 状态恢复

Session Summary、Memory、Trace 索引和未完成 TaskState 可读取。

### R03 权限变化

卸载期间移除一个 Tool，恢复后的 Profile 不再包含该 Tool。

### R04 Control Plane 重启

重启后从 PostgreSQL 重建 Runtime cache，不丢 logical agent 和已保存状态。

---

## 13. 云端验收

最终执行：

```bash
pnpm demo:preflight
pnpm demo:deploy
pnpm demo:status
pnpm demo:verify
```

`demo:verify` 至少运行：

- stable version 检查；
- 三个 L1 scope 创建；
- LEGAL/ROBOT_DOG E2E；
- Skill/Tool/Memory 隔离；
- L1/L2 lifecycle；
- L1 restore。

报告明确标记：

- 哪些链路真实经过 OpenClaw；
- 哪些 Tool 是 Mock；
- 哪些安全/高可用能力被明确推迟。

---

## 14. Pass / Fail

P0 失败：

- 跨租户或跨业务 Memory/数据读取；
- L2 获得父级没有的 Skill/Tool；
- 不同 L1 共用 agentDir/Session namespace；
- 持久化失败后仍标记 UNLOADED；
- `config.txt` 或真实密钥进入 Git/报告。

其他未实现的生产级安全能力不算 Demo 失败，只需写入未来建议。
