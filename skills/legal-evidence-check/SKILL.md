---
name: legal-evidence-check
description: Check one scoped legal case for a coherent evidence chain in the AgentNest demo.
---

# Legal evidence check

Version: `1.0.0`

Use this skill only for a `LEGAL_EVIDENCE_CHECK` task delivered to a LEGAL task
agent. Never use it for another business domain.

## Required task context

The task message must include:

- `task_id`
- `tenant_id`
- `biz_domain=LEGAL`
- `resource_type=CASE`
- `resource_id`

For a normal tool-backed run the first line must be the controller envelope that
contains `execution_context_id`. The runtime plugin binds that opaque ID to the
Session; it is intentionally not a model-visible Tool argument. Do not add it to
Tool parameters or invent/override tenant, business, resource, or permission fields.

## Workflow

1. Call `legal_case_read` with action `read` for the requested case.
2. Call `legal_research_query` with action `query` only when the task explicitly
   asks for external research.
3. Assess whether the returned material identifies the fact to prove, its
   source, and any missing link. Do not fabricate evidence.
4. Call `legal_analysis_write` with action `write` to save the concise result.
5. Return exactly one completion line in this form:

```text
AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=LEGAL_EVIDENCE_CHECK|status=COMPLETED|role=LEGAL
```

If a required tool rejects the call, do not claim completion or retry with a
different scope. Return exactly:

```text
AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=LEGAL_EVIDENCE_CHECK|status=DENIED|role=LEGAL
```

## Phase 3 chain probe

When the task explicitly contains `phase3_chain_probe=true`, do not claim that
a business tool ran. Return exactly this single line so the native L0 to L1 to
L2 session chain can be verified before the Phase 4 Gateway Mock is enabled:

```text
AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=LEGAL_EVIDENCE_CHECK|status=CHAIN_OK|role=LEGAL|tool_mode=NOT_RUN
```
