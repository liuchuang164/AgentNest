# OpenClaw workspace templates

These templates are copied into each actual OpenClaw profile's independent
workspace. Deployment must replace every placeholder before starting OpenClaw
and must fail if any token matching `__[A-Z0-9_]+__` remains.

| Role template | Required replacements |
| --- | --- |
| `workspaces/main/AGENTS.md` | `__L1_ROUTE_TABLE_JSON__` |
| `workspaces/l1-legal/AGENTS.md` | `__TENANT_ID__`, `__BIZ_DOMAIN__`, `__L1_AGENT_ID__`, `__L2_AGENT_ID__` |
| `workspaces/l1-robot-dog/AGENTS.md` | `__TENANT_ID__`, `__BIZ_DOMAIN__`, `__L1_AGENT_ID__`, `__L2_AGENT_ID__` |
| `workspaces/l2-legal-evidence-check/AGENTS.md` | `__TENANT_ID__`, `__BIZ_DOMAIN__`, `__L2_AGENT_ID__` |
| `workspaces/l2-robot-dog-health-check/AGENTS.md` | `__TENANT_ID__`, `__BIZ_DOMAIN__`, `__L2_AGENT_ID__` |

`__L1_ROUTE_TABLE_JSON__` is a JSON array owned by the deployment adapter. Each
entry contains the normalized `tenant_id`, `biz_domain`, `task_type`, and the
L1 main `sessionKey` to use with `sessions_send`.

The allowlists live in the OpenClaw profile configuration, not in these prompt
files. The intended views are:

| Role | Skills | Tools |
| --- | --- | --- |
| L0 `main` | empty | `sessions_send`, `session_status` |
| LEGAL L1 | `legal-evidence-check` | native session-management tools plus LEGAL tools only |
| ROBOT_DOG L1 | `robot-dog-health-check` | native session-management tools plus ROBOT_DOG tools only |
| LEGAL L2 | `legal-evidence-check` | LEGAL tools only |
| ROBOT_DOG L2 | `robot-dog-health-check` | ROBOT_DOG tools only |

The L1 templates always call the native `sessions_spawn` tool with a fixed L2
profile, `context: "isolated"`, `mode: "run"`, and `cleanup: "keep"`. Keeping
the session makes the independent child session observable as Phase 3 evidence.
