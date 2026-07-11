# Security Policy

AgentNest is a public demo repository for multi-tenant agent isolation. Do not use real tenant data or production credentials in issues, commits, test fixtures, screenshots, logs, or reports.

## Secret handling

Never commit:

- `config.txt`;
- `.env` files;
- SSH private keys;
- model/API keys;
- database or MinIO passwords;
- OpenClaw auth profiles;
- Capability Tokens;
- unredacted Session transcripts.

`config.txt` and common secret files are excluded by `.gitignore`. This does not replace secret scanning or human review.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities that could expose credentials, cross-tenant data, Agent sessions, or remote servers. Contact the repository owner privately through an agreed secure channel.

Include:

- affected commit;
- reproduction steps using synthetic data;
- expected and observed authorization decision;
- whether a data/tool side effect occurred;
- relevant redacted Trace/Audit IDs;
- suggested mitigation when known.

## Security-critical failures

The following are release blockers:

- cross-tenant or cross-business data/Memory access;
- child Agent privilege escalation;
- Tool execution without a valid Capability Token;
- Token/session/task context confusion;
- checkpoint failure followed by runtime destruction;
- secret material in Git or reports;
- public exposure of OpenClaw Gateway, databases, Redis, MinIO Console, or Admin API without an approved secure boundary.

See `AGENTS.md` and `docs/security-isolation.md` for the mandatory security model.
