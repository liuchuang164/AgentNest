# Hermes 最终验收清单

> 每项必须填写真实测试名、Trace ID、命令摘要或证据路径。没有证据不得勾选。

## A. 范围

- [ ] 本次仅修改 `apps/hermes/**`、`docs/hermes/**` 及 Hermes 导航/任务书。证据：
- [ ] 未实现或修改 OpenClaw。证据：
- [ ] 未实现或修改 Agent Control Plane。证据：
- [ ] 未实现或修改 Gateway/业务 Skill。证据：
- [ ] 未把 OpenClaw Demo Issue #1 当成 Hermes 工作跟踪。证据：

## B. 构建

- [ ] `pnpm lint` 成功。证据：
- [ ] TypeScript strict typecheck 成功。证据：
- [ ] Unit tests 成功。证据：
- [ ] Integration tests 成功。证据：
- [ ] JSON Schema/契约校验成功。证据：
- [ ] `pnpm hermes:verify` 退出码为 0。证据：
- [ ] 没有提交 `config.txt/.env` 或真实密钥。证据：

## C. 三种调用模式

- [ ] `HERMES_ONLY` 只调用 standalone model path。证据：
- [ ] `HERMES_ONLY` Planner/SOP DAG 调用为 0。证据：
- [ ] `HERMES_ONLY` Control Plane/OpenClaw 调用为 0。证据：
- [ ] `OPENCLAW_ONLY` 不进入 Hermes。证据：
- [ ] Hermes 收到 `OPENCLAW_ONLY` 返回稳定错误。证据：
- [ ] 只有 `HERMES_OPENCLAW` 进入复杂多 Agent 编排。证据：
- [ ] 模型/任务复杂度不能擅自修改 execution mode。证据：

## D. SOP

- [ ] SOP 按 tenant+biz+task 选择。证据：
- [ ] Run 锁定 `sop_id + version`。证据：
- [ ] 运行中发布新 SOP 不改变已锁定 Run。证据：
- [ ] tenant_A 不能加载 tenant_B SOP。证据：
- [ ] 找不到 SOP 不跨 scope fallback。证据：
- [ ] SOP 通过 Schema 校验并可版本回滚。证据：

## E. DAG

- [ ] 节点 ID 唯一。证据：
- [ ] 缺失依赖被拒绝。证据：
- [ ] 环被拒绝。证据：
- [ ] 必需输入闭包校验。证据：
- [ ] 输出 Schema 已注册。证据：
- [ ] capability intent 超范围被拒绝。证据：
- [ ] 并行 write set 冲突被拒绝/拆分。证据：
- [ ] join policy 明确。证据：
- [ ] 必需节点都有可检查完成标准。证据：
- [ ] DAG/重试/Replan 有硬上限。证据：

## F. Hermes / Control Plane 边界

- [ ] Hermes 先查询 execution context。证据：
- [ ] Hermes 根据事实选择 strategy。证据：
- [ ] Control Plane 只返回事实/硬拒绝，不选业务 fallback。证据：
- [ ] query context 不被当成 reservation。证据：
- [ ] 无有效 reservation 不 dispatch。证据：
- [ ] reservation 过期后不 dispatch。证据：
- [ ] Plan 变化后重新 reserve。证据：
- [ ] cancel/release 幂等。证据：
- [ ] Hermes 未读取底层资源数据库或 Redis。证据：
- [ ] Hermes 未直接创建/恢复/销毁 Agent。证据：

## G. 策略

- [ ] 独立节点+资源足够可并行。证据：
- [ ] 槽位不足可分批并行。证据：
- [ ] 强依赖/写冲突可串行。证据：
- [ ] 排队不超过用户/SOP 最大等待。证据：
- [ ] Tool 限流由 Hermes 按 SOP 选择 fallback。证据：
- [ ] 预算不足可进入人工确认/降级/失败。证据：
- [ ] Adapter 不擅自切换业务 Tool。证据：

## H. 质量与重规划

- [ ] 确定性 Schema 硬失败不能被模型 PASS 覆盖。证据：
- [ ] 必需节点缺失不会完成。证据：
- [ ] 证据引用缺失有明确 decision。证据：
- [ ] Replan 保留旧 Plan 并创建新 version。证据：
- [ ] Replan 记录 reason/evidence/diff。证据：
- [ ] 只重跑受影响节点闭包。证据：
- [ ] 达到最大 Replan 次数后停止自动循环。证据：
- [ ] 人工确认带 actor、scope、run version。证据：
- [ ] 过期人工批准被拒绝。证据：

## I. 租户隔离

- [ ] trusted context 不从自然语言生成。证据：
- [ ] body 不能覆盖 trusted tenant/user/role。证据：
- [ ] SOP/Run/Plan/Decision/Evaluation Repository 强制 tenant+biz。证据：
- [ ] tenant_A 和 tenant_B 同名 `case_001` 不交叉。证据：
- [ ] Prompt/Tool result injection 不能扩大权限。证据：
- [ ] Control Plane scope mismatch 被拒绝。证据：
- [ ] human action 不能跨 tenant/run。证据：
- [ ] 缓存 key 包含 tenant+biz。证据：

## J. 模型与 Prompt

- [ ] 所有模型调用经过 ModelProvider。证据：
- [ ] Prompt 模板版本化。证据：
- [ ] 模型输出经过运行时 Schema 校验。证据：
- [ ] invalid JSON/oversize/timeout 有稳定错误。证据：
- [ ] Unit test 使用 Fake Model。证据：
- [ ] 完整 Prompt/响应未进入默认日志。证据：
- [ ] 供应商 SDK 未泄漏到 domain/application。证据：

## K. 幂等与恢复

- [ ] 同一 idempotency key 只创建一个 Run。证据：
- [ ] dispatch 使用稳定幂等键。证据：
- [ ] 崩溃恢复先查询外部 execution status。证据：
- [ ] 已接收 dispatch 不重复派发。证据：
- [ ] EVALUATING 可幂等恢复。证据：
- [ ] release_pending 可后台重试。证据：
- [ ] Hermes 不复制 Control Plane 权威资源状态。证据：

## L. 可观测性

- [ ] request/trace/run/plan/execution ID 可关联。证据：
- [ ] Hermes decision 与外部事实分开记录。证据：
- [ ] reason code 稳定。证据：
- [ ] 日志脱敏测试通过。证据：
- [ ] 报告明确 Fake 与真实集成。证据：
- [ ] 未伪造模型、OpenClaw 或 Control Plane 测试证据。证据：

## M. 16 条主流程

- [ ] F01 可信接入与模式分流。证据：
- [ ] F02 HERMES_ONLY 直接响应。证据：
- [ ] F03 混合模式任务识别。证据：
- [ ] F04 Agent Binding 解析。证据：
- [ ] F05 SOP 选择与版本锁定。证据：
- [ ] F06 候选 DAG 规划。证据：
- [ ] F07 DAG 静态校验。证据：
- [ ] F08 查询真实执行条件。证据：
- [ ] F09 执行策略决策。证据：
- [ ] F10 资源预留、排队与派发。证据：
- [ ] F11 多 Agent 执行监控。证据：
- [ ] F12 结构化结果接收。证据：
- [ ] F13 全局质量验收。证据：
- [ ] F14 Fallback 与有界重规划。证据：
- [ ] F15 人工确认。证据：
- [ ] F16 终态、释放与崩溃恢复。证据：

## N. 最终结论

- [ ] 模式边界正确。
- [ ] Hermes/Control Plane/OpenClaw 职责未混淆。
- [ ] 多租户无泄漏。
- [ ] DAG、reservation、质量和 Replan 闭环已验证。
- [ ] 没有范围外实现。

```text
Name:
Date:
AgentNest commit:
Hermes contract version:
Verification run_id:
Fake integrations:
Real integrations:
Conclusion: PASS / FAIL
```
