# Security Policy

AgentNest is a public technical-demo repository for tenant/business Agent isolation. Do not use real tenant data or production credentials in commits, issues, fixtures, screenshots, logs, transcripts, or reports.

## Secret handling

Never commit:

- `config.txt`;
- `.env` files;
- SSH private keys;
- model/API keys;
- database passwords;
- OpenClaw credential profiles;
- unredacted Session transcripts.

The repository `.gitignore` excludes common secret files, but developers must still review changes before committing.

## Demo security boundary

The first Demo protects only the following essential boundaries:

- L1 Agent Profiles are isolated by `tenant_id + biz_domain`;
- L2 Skill/Tool permissions are a subset of L1 permissions;
- Task, Memory, Trace, Session and Demo resource queries carry tenant+business scope;
- Gateway Mock loads a server-side `execution_context` and does not trust model-supplied tenant/biz values;
- unauthorized Tool calls are rejected without business side effects;
- checkpoint persistence must succeed before runtime unload;
- OpenClaw, PostgreSQL and Admin/Test endpoints are private by default.

## Explicit non-goals for the first Demo

The first Demo does not require:

- Capability Tokens, JWT/JWS/PASETO;
- PKI, mTLS or zero-trust networking;
- OAuth or production RBAC;
- Redis, MinIO, Kafka or Outbox;
- distributed locks or multi-node HA;
- vector databases;
- tamper-evident audit chains;
- Kubernetes or production hardening suites.

These can be evaluated after the three-layer Agent architecture is proven.

## Reporting a vulnerability

Do not open a public issue for a problem that could expose credentials, another tenant's data, Agent sessions, or remote-server access. Contact the repository owner privately through an agreed channel.

Include a synthetic-data reproduction, affected commit, expected/observed behavior, whether a side effect occurred, and redacted Trace IDs.

## Demo release blockers

- cross-tenant or cross-business data/Memory access;
- child Agent privilege escalation;
- different L1 Agents sharing an agentDir or Session namespace;
- Tool execution outside the server-side execution context;
- checkpoint failure followed by `UNLOADED` state;
- secret material in Git or reports;
- public exposure of OpenClaw, PostgreSQL, or Admin/Test APIs by default.

See `AGENTS.md` and `docs/security-isolation.md` for the current Demo rules.
