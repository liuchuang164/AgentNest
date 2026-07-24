# Hermes 验证测试方案

## 1. 验证目标

测试必须用可复现证据回答：

1. 三种调用模式是否严格分流；
2. standalone 模式是否完全不触发复杂多 Agent 链路；
3. 混合模式是否按 SOP 生成并校验 DAG；
4. 是否先查询真实条件、由 Hermes 决策、再申请 reservation；
5. Hermes 和 Control Plane 的策略/硬约束边界是否成立；
6. 质量不达标是否有界重规划；
7. tenant/biz SOP、Run、Plan、Decision 是否隔离；
8. 崩溃恢复是否避免重复派发；
9. 模型随机性是否被结构化契约和 Fake 测试隔离；
10. 是否没有开发 OpenClaw、Control Plane、Gateway 或业务 Skill。

---

## 2. 测试数据

| Tenant | Biz | Task | SOP |
|---|---|---|---|
| tenant_A | LEGAL | CASE_PRELIMINARY_OVERVIEW | sop_case_overview v3 |
| tenant_A | ROBOT_DOG | DEVICE_HEALTH_REVIEW | sop_device_health v1 |
| tenant_B | LEGAL | CASE_PRELIMINARY_OVERVIEW | sop_case_overview v2 |

tenant_A 与 tenant_B 都使用：

```text
workspace_id = case_001
```

用于证明不能只按 workspace ID 查询。

Fake Control Plane 提供可脚本化场景：

```text
2 slots available
0 slots + queue 20s
ali_farui rate limited 120s
budget exhausted
write conflict
reservation expires
agent busy/restorable/denied
```

---

## 3. Unit Tests

### U01 模式路由

- `HERMES_ONLY` → standalone handler；
- `OPENCLAW_ONLY` → `MODE_NOT_HANDLED_BY_HERMES`；
- `HERMES_OPENCLAW` → orchestration handler；
- 未知 mode → Schema 拒绝；
- 不允许模型或 task complexity 修改 mode。

### U02 Trusted Context

- body 与 trusted tenant 一致 → 通过；
- body 伪造其他 tenant → 拒绝；
- 缺 trusted context → 拒绝；
- biz/workspace 不在授权映射 → 拒绝。

### U03 SOP 选择

- 按 tenant/biz/task 选择；
- 版本锁定；
- tenant_A 不能读取 tenant_B；
- 找不到不跨 tenant fallback；
- Run 中途发布 v4 不改变已锁定 v3。

### U04 DAG Schema

覆盖：

- 正常图；
- 重复节点；
- 缺失依赖；
- 环；
- 缺必需输入；
- 未注册输出 Schema；
- 节点过多；
- 无完成标准；
- 未知 join policy。

### U05 Write Set

- 相同目标并行拒绝；
- 父/子目标冲突拒绝；
- 无冲突目标允许；
- 明确 append-only 契约允许；
- 模糊任意字符串拒绝。

### U06 Capability Intent

- intent 在 catalog → 保留；
- 不在 tenant scope → 拒绝；
- Prompt 指定未授权 Tool → 拒绝；
- Control Plane scope 更窄 → effective intent 收窄并触发 Replan/失败；
- 不能自动补回能力。

### U07 Strategy Decider

表驱动测试：

| Context | SOP | 预期 |
|---|---|---|
| 2 slots，3 independent nodes | allow parallel | BATCHED_PARALLEL |
| 1 slot | allow fallback | SERIAL |
| 0 slot，queue 20s，limit 60s | allow queue | QUEUE |
| 0 slot，queue 120s，limit 60s | no wait | FAIL/HUMAN |
| write conflict | split possible | SERIAL/BATCH |
| budget exhausted | human allowed | WAITING_HUMAN |

### U08 Reservation

- context 后才能 reserve；
- reserve success 才 dispatch；
- 过期 reservation 不 dispatch；
- Plan version 变化必须重新 reserve；
- repeated reserve 使用幂等键；
- terminal state release 幂等。

### U09 Error Mapping

每个供应商/HTTP 错误映射为稳定领域码，且保留 `retryable` 和
`retry_after_seconds`；不泄漏原始机密。

### U10 Quality Evaluation

- required node missing → 不 PASS；
- Schema invalid → 不 PASS；
- evidence missing → REPLAN/DEGRADED；
- conflict → HUMAN/REPLAN；
- 全部 criterion 通过 → PASS；
- 模型辅助 PASS 不能覆盖硬失败。

### U11 Replan Limit

- 第 1、2 次可 Replan；
- 第 3 次被硬阻止；
- 进入 WAITING_HUMAN/DEGRADED/FAIL；
- 不产生第 4 个 Plan；
- 只重跑受影响节点闭包。

### U12 状态机

所有合法转换通过，非法转换返回领域错误。终态不能回到 RUNNING。

### U13 Prompt 构造

- system/SOP/user/result 分区固定；
- user 中“忽略规则”不进入 system；
- Tool 结果不能覆盖 tenant；
- 完整 Prompt 不进入日志；
- Prompt version/model config 被记录。

### U14 日志脱敏

覆盖：

```text
authorization
api_key
password
private key
database URL
完整材料
```

---

## 4. Integration Tests

### I01 Repository Scope

所有 SOP/Run/Plan/Decision/Evaluation Repository API 都要求
`TenantBizScope`。tenant_A 与 tenant_B 的 `case_001` 不交叉。

### I02 幂等创建

同一 tenant/request/idempotency key 并发提交：

- 只有一个 Run；
- 只有一个有效 Plan v1；
- 不重复 dispatch。

不同 tenant 使用同一 idempotency key 不冲突。

### I03 Plan 版本

Replan 创建 version+1，旧 Plan 不变，decision 指向 previous plan。

### I04 Outbound Call Log

模拟进程在 dispatch 响应前崩溃：

- 恢复后先 query status；
- 外部已接收则绑定 execution_id；
- 未接收才安全重试；
- 不重复创建执行。

### I05 Human Action

- 正确 version 批准；
- 旧 version 冲突；
- 重复 action 幂等；
- 跨 tenant action 拒绝；
- terminal Run 拒绝。

### I06 Model Provider

覆盖 timeout、取消、429、5xx、invalid JSON、oversize response 和成功结构化输出。

---

## 5. 三种模式 E2E

### E01 HERMES_ONLY

```text
request
→ trusted context
→ standalone prompt
→ Fake Model
→ schema validate
→ response
```

证据：

- Run status；
- model call = 1；
- SOP/DAG planner call = 0；
- Control Plane call = 0；
- OpenClaw call = 0；
- reservation/execution ID 为空。

### E02 OPENCLAW_ONLY

在 Hermes API 直接提交该 mode：

```text
→ MODE_NOT_HANDLED_BY_HERMES
```

统一入口的真实路由测试属于整体服务；Hermes 只证明它不会代理或误处理。

### E03 HERMES_OPENCLAW Happy Path

```text
classify
→ lock SOP
→ plan/validate
→ resolve agent
→ get context
→ decide BATCHED_PARALLEL
→ reserve
→ dispatch
→ fake node results
→ evaluate PASS
→ release
```

### E04 Rate Limit Fallback

阿里法睿限流 120 秒，SOP 允许本地 RAG：

- Control Plane 只返回错误；
- Hermes 记录 decision；
- Plan v2 使用本地 RAG；
- 再次校验、context、reserve；
- 原适配器没有偷偷切换 Tool。

### E05 Resource Shortage

3 个独立节点，只有 2 个槽位：

- Hermes 选择 `BATCHED_PARALLEL`；
- reservation parallelism=2；
- Plan batches 可验证；
- 不申请第 3 个并发槽位。

### E06 Quality Replan

执行完成但法律依据缺失：

- 不标记 COMPLETED；
- Evaluation=REPLAN；
- Plan v2 增加 legal search 节点；
- 只重跑影响闭包；
- 达标后完成。

### E07 Human Gate

预算不足且无安全 fallback：

- WAITING_HUMAN；
- 不 dispatch；
- 用户批准降级后生成新 Plan；
- 用户取消则 cancel/release。

---

## 6. 安全隔离测试

每个负向测试至少验证：

```text
请求被拒绝
没有产生外部 dispatch/业务副作用
Trace 有 reason code
没有跨 tenant 数据出现在响应或日志
```

覆盖：

- body 伪造 tenant；
- 跨 tenant SOP；
- 跨 tenant Run；
- 未授权 Tool intent；
- Control Plane scope mismatch；
- Prompt injection；
- Tool result injection；
- 过期 human approval；
- 日志机密。

---

## 7. 恢复测试

### R01 PLANNED 恢复

重新执行 context/reserve，不重复创建 Plan v1。

### R02 RESERVED 恢复

检查 reservation 是否有效；有效则 dispatch，过期则重新 context/decide/reserve。

### R03 DISPATCHED/RUNNING 恢复

先 `get_execution_status`，禁止盲目 dispatch。

### R04 EVALUATING 恢复

使用已保存结果引用重新执行幂等 Evaluation。

### R05 Release Pending

业务终态保持，后台重试幂等 release。

---

## 8. Contract Tests

与 Control Plane/OpenClaw 集成只要求契约：

- 请求/响应 Schema；
- enum；
- timeout；
- error mapping；
- idempotency；
- trace propagation；
- scope echo/validation；
- version negotiation。

若外部真实服务不可用，Fake 测试必须明确标为 Fake，不得写“真实多 Agent 已验证”。

---

## 9. 验证命令目标

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm hermes:verify
```

`hermes:verify` 输出：

```text
mode isolation
SOP/DAG validation
strategy cases
Control Plane contract
quality/replan
tenant isolation
recovery/idempotency
fake vs real integration
```

失败返回非零。

---

## 10. P0 Fail

- `HERMES_ONLY` 调用了 Control Plane/OpenClaw；
- `OPENCLAW_ONLY` 被 Hermes 代理；
- 无 reservation 派发；
- 跨 tenant SOP/Run/Plan 泄漏；
- 未授权 capability 被派发；
- DAG 有环/写冲突仍派发；
- 硬质量失败仍 PASS；
- 无限 Replan；
- 恢复重复 dispatch；
- 机密进入 Git/日志/报告；
- 修改了范围外服务；
- Fake 被宣称为真实集成。
