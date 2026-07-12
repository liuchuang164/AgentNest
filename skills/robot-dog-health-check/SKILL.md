---
name: robot-dog-health-check
description: Check one scoped robot-dog device health record in the AgentNest demo.
---

# Robot-dog health check

Version: `1.0.0`

Use this skill only for a `ROBOT_DOG_HEALTH_CHECK` task delivered to a
ROBOT_DOG task agent. Never use it for another business domain.

## Required task context

The task message must include:

- `task_id`
- `tenant_id`
- `biz_domain=ROBOT_DOG`
- `resource_type=DEVICE`
- `resource_id`

For a normal tool-backed run the first line must be the controller envelope that
contains `execution_context_id`. The runtime plugin binds that opaque ID to the
Session; it is intentionally not a model-visible Tool argument. Do not add it to
Tool parameters or invent/override tenant, business, resource, or permission fields.

## Workflow

1. Call `robot_device_read` with action `read` for the requested device.
2. Call `robot_telemetry_enrich` with action `query` when telemetry enrichment
   is needed for the requested health check.
3. Summarize the observed health signals and flag missing telemetry. Do not
   fabricate measurements.
4. Call `robot_health_write` with action `write` to save the concise result.
5. Return exactly one completion line in this form:

```text
AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=ROBOT_DOG_HEALTH_CHECK|status=COMPLETED|role=ROBOT_DOG
```

If a required tool rejects the call, do not claim completion or retry with a
different scope. Return exactly:

```text
AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=ROBOT_DOG_HEALTH_CHECK|status=DENIED|role=ROBOT_DOG
```

## Phase 3 chain probe

When the task explicitly contains `phase3_chain_probe=true`, do not claim that
a business tool ran. Return exactly this single line so the native L0 to L1 to
L2 session chain can be verified before the Phase 4 Gateway Mock is enabled:

```text
AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=ROBOT_DOG_HEALTH_CHECK|status=CHAIN_OK|role=ROBOT_DOG|tool_mode=NOT_RUN
```
