import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { workspaceRoot } from "../deploy/remote.js";

type JsonRecord = Readonly<Record<string, unknown>>;
type CheckStatus = "PASS" | "FAIL" | "MISSING" | "BLOCKED_EXTERNAL";
export type Phase6ReportStatus = "PASS" | "FAIL" | "INCOMPLETE" | "BLOCKED_EXTERNAL";

const evidencePaths = {
  preflight: "artifacts/reports/remote-preflight-summary.json",
  deployment: "artifacts/reports/phase-6-deployment-summary.json",
  status: "artifacts/reports/phase-6-status.json",
  verification: "artifacts/reports/phase-6-verification-summary.json",
  openclaw: "artifacts/reports/phase-3-remote-e2e.json",
} as const;

const reportJsonPath = resolve(workspaceRoot, "artifacts/reports/phase-6-summary.json");
const reportMarkdownPath = resolve(workspaceRoot, "artifacts/reports/phase-6-summary.md");

export interface Phase6Evidence {
  readonly preflight: JsonRecord | null;
  readonly deployment: JsonRecord | null;
  readonly status: JsonRecord | null;
  readonly verification: JsonRecord | null;
  readonly openclaw: JsonRecord | null;
  readonly issues?: readonly string[];
}

interface AcceptanceCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly evidence: string;
  readonly note: string;
}

interface SanitizedTestResult {
  readonly category: string;
  readonly name: string;
  readonly status: string;
  readonly evidence: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : null;
}

function testResults(verification: JsonRecord | null): readonly SanitizedTestResult[] {
  if (verification === null) {
    return [];
  }
  const categories = [
    "real_openclaw_tests",
    "postgres_tests",
    "isolation_tests",
    "mock_tool_tests",
    "lifecycle_tests",
    "recovery_tests",
  ] as const;
  const results: SanitizedTestResult[] = [];
  for (const category of categories) {
    const value = verification[category];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (!isRecord(item)) {
        continue;
      }
      const name = safeString(item["name"]);
      const status = safeString(item["status"]);
      const evidence = safeString(item["evidence"]);
      if (name !== null && status !== null && evidence !== null) {
        results.push({ category, name, status, evidence });
      }
    }
  }
  return results;
}

function checkStatus(
  record: JsonRecord | null,
  pass: (value: JsonRecord) => boolean,
  blocked: (value: JsonRecord) => boolean = () => false,
): CheckStatus {
  if (record === null) {
    return "MISSING";
  }
  if (pass(record)) {
    return "PASS";
  }
  return blocked(record) ? "BLOCKED_EXTERNAL" : "FAIL";
}

function overallStatus(checks: readonly AcceptanceCheck[]): Phase6ReportStatus {
  if (checks.some((check) => check.status === "FAIL")) {
    return "FAIL";
  }
  if (checks.some((check) => check.status === "MISSING")) {
    return "INCOMPLETE";
  }
  if (checks.some((check) => check.status === "BLOCKED_EXTERNAL")) {
    return "BLOCKED_EXTERNAL";
  }
  return "PASS";
}

function externalBlocker(openclaw: JsonRecord | null): JsonRecord | null {
  const blocker = asRecord(openclaw?.["external_blocker"]);
  const provider = safeString(blocker["provider"]);
  const code = safeString(blocker["code"]);
  const httpStatus = blocker["http_status"];
  if (provider === null && code === null && typeof httpStatus !== "number") {
    return null;
  }
  return {
    ...(provider === null ? {} : { provider }),
    ...(code === null ? {} : { code }),
    ...(typeof httpStatus === "number" ? { http_status: httpStatus } : {}),
  };
}

export function buildPhase6AcceptanceReport(
  evidence: Phase6Evidence,
  now = new Date(),
): JsonRecord {
  const preflightSsh = asRecord(evidence.preflight?.["ssh"]);
  const preflightBlockers = evidence.preflight?.["blockers"];
  const deploymentServices = evidence.deployment?.["services"];
  const checks: readonly AcceptanceCheck[] = [
    {
      name: "remote_read_only_preflight",
      status: checkStatus(evidence.preflight, (record) => {
        return (
          record["read_only"] === true &&
          preflightSsh["connected"] === true &&
          Array.isArray(preflightBlockers) &&
          preflightBlockers.length === 0
        );
      }),
      evidence: evidencePaths.preflight,
      note: "SSH, host capacity and project-owned ports passed the read-only probe",
    },
    {
      name: "repeatable_compose_deployment",
      status: checkStatus(evidence.deployment, (record) => {
        return (
          record["status"] === "PASS" &&
          typeof record["successful_deploy_count"] === "number" &&
          record["successful_deploy_count"] >= 2 &&
          record["bindings"] === "loopback_or_private" &&
          Array.isArray(deploymentServices) &&
          deploymentServices.length === 4
        );
      }),
      evidence: evidencePaths.deployment,
      note: "The same committed source and four loopback/private services passed at least two deployments",
    },
    {
      name: "deployed_service_health",
      status: checkStatus(evidence.status, (record) => record["status"] === "PASS"),
      evidence: evidencePaths.status,
      note: "Control Plane, Gateway Mocks, PostgreSQL and OpenClaw are healthy",
    },
    {
      name: "remote_platform_verification",
      status: checkStatus(
        evidence.verification,
        (record) => record["status"] === "PASS",
        (record) => record["status"] === "BLOCKED_EXTERNAL" && record["platform_passed"] === true,
      ),
      evidence: evidencePaths.verification,
      note: "Real PostgreSQL, scoped isolation, lifecycle and recovery evidence is aggregated",
    },
    {
      name: "real_openclaw_l0_l1_l2_chain",
      status: checkStatus(
        evidence.openclaw,
        (record) => record["status"] === "PASS",
        (record) => record["status"] === "BLOCKED_EXTERNAL",
      ),
      evidence: evidencePaths.openclaw,
      note: "This check is real OpenClaw evidence, not the deterministic local E2E transport",
    },
  ];
  const status = overallStatus(checks);
  const deployment = evidence.deployment ?? {};
  const openclaw = asRecord(evidence.openclaw?.["openclaw"]);
  const stable = asRecord(evidence.openclaw?.["official_stable"]);
  return {
    schema_version: "1.0",
    phase: 6,
    generated_at: now.toISOString(),
    status,
    completed: status === "PASS",
    agentnest_commit: safeString(deployment["agentnest_commit"]),
    verification_run_id: safeString(evidence.verification?.["run_id"]),
    runtime: {
      node: safeString(deployment["node_version"]),
      pnpm: safeString(deployment["pnpm_version"]),
      docker: safeString(deployment["docker_version"]),
      compose: safeString(deployment["compose_version"]),
    },
    openclaw: {
      expected_stable_version: safeString(stable["version"]),
      observed_version: safeString(openclaw["observed_version"]),
      deployment_version: safeString(deployment["openclaw_version"]),
      channel: "stable",
    },
    checks,
    tests: testResults(evidence.verification),
    evidence_issues: [...(evidence.issues ?? [])],
    external_blocker: externalBlocker(evidence.openclaw),
    claims: {
      deterministic_test_e2e: "LOCAL_FAKE_OPENCLAW_TRANSPORT",
      remote_openclaw_chain: status === "PASS" ? "VERIFIED" : "NOT_ACCEPTED",
      gateway_tools: "DETERMINISTIC_MOCKS_WITH_POSTGRES_SIDE_EFFECTS",
    },
    deferred_production_capabilities: [
      "Capability tokens and full IAM",
      "Redis or multi-node coordination",
      "MinIO or vector memory",
      "Kubernetes and high availability",
    ],
  };
}

function containsSensitiveEvidence(value: unknown, key = ""): boolean {
  if (
    /^(?:SSH_PASSWORD|MODEL_API_KEY|POSTGRES_PASSWORD|DEMO_API_TOKEN|DATABASE_URL|PRIVATE_KEY)$/iu.test(
      key,
    )
  ) {
    return true;
  }
  if (typeof value === "string") {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/|\bsk-[A-Za-z0-9_-]{16,}/u.test(
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveEvidence(item));
  }
  return isRecord(value)
    ? Object.entries(value).some(([nestedKey, nested]) =>
        containsSensitiveEvidence(nested, nestedKey),
      )
    : false;
}

async function loadEvidence(relativePath: string): Promise<{
  readonly record: JsonRecord | null;
  readonly issue: string | null;
}> {
  const absolutePath = resolve(workspaceRoot, relativePath);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch {
    return { record: null, issue: `${relativePath}: missing` };
  }
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    return { record: null, issue: `${relativePath}: exceeds 1 MiB evidence limit` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { record: null, issue: `${relativePath}: invalid JSON` };
  }
  if (!isRecord(value) || containsSensitiveEvidence(value)) {
    return { record: null, issue: `${relativePath}: invalid or sensitive evidence` };
  }
  return { record: value, issue: null };
}

function markdownEscape(value: unknown): string {
  if (typeof value === "string") {
    return value.replaceAll("|", "\\|");
  }
  return typeof value === "number" || typeof value === "boolean" ? String(value) : "-";
}

function renderMarkdown(report: JsonRecord): string {
  const checks = Array.isArray(report["checks"]) ? report["checks"].filter(isRecord) : [];
  const tests = Array.isArray(report["tests"]) ? report["tests"].filter(isRecord) : [];
  const runtime = asRecord(report["runtime"]);
  const openclaw = asRecord(report["openclaw"]);
  const issues = Array.isArray(report["evidence_issues"])
    ? report["evidence_issues"].filter((value): value is string => typeof value === "string")
    : [];
  return `# Phase 6 云端 Demo 验收摘要

- 结论：\`${markdownEscape(report["status"])}\`
- AgentNest commit：\`${markdownEscape(report["agentnest_commit"])}\`
- Verification run：\`${markdownEscape(report["verification_run_id"])}\`
- OpenClaw stable：\`${markdownEscape(openclaw["observed_version"])}\`
- Node / pnpm：\`${markdownEscape(runtime["node"])}\` / \`${markdownEscape(runtime["pnpm"])}\`

## 验收 Gate

| 检查 | 状态 | 证据 | 说明 |
| --- | --- | --- | --- |
${checks
  .map(
    (check) =>
      `| ${markdownEscape(check["name"])} | ${markdownEscape(check["status"])} | \`${markdownEscape(check["evidence"])}\` | ${markdownEscape(check["note"])} |`,
  )
  .join("\n")}

## 自动验证结果

| 类别 | 测试 | 状态 | 证据 |
| --- | --- | --- | --- |
${
  tests.length === 0
    ? "| - | 尚无验证结果 | MISSING | - |"
    : tests
        .map(
          (test) =>
            `| ${markdownEscape(test["category"])} | ${markdownEscape(test["name"])} | ${markdownEscape(test["status"])} | \`${markdownEscape(test["evidence"])}\` |`,
        )
        .join("\n")
}

## 证据完整性

${issues.length === 0 ? "- 所需脱敏 JSON 证据均已读取。" : issues.map((issue) => `- ${issue}`).join("\n")}

## 边界

- \`pnpm test:e2e\` 使用显式 fake OpenClaw transport，只验证应用编排，不冒充真实 OpenClaw。
- 真实三层链路只由远端 OpenClaw evidence 判定。
- LEGAL/ROBOT_DOG Tool 是确定性 Mock；副作用、DENY Trace 与 scope 查询落在真实 PostgreSQL 16。
- JWT/IAM、Redis、多节点 HA、MinIO、向量 Memory 和 Kubernetes 属于后续生产化建议。
`;
}

async function main(): Promise<void> {
  const entries = await Promise.all(
    Object.values(evidencePaths).map(async (path) => await loadEvidence(path)),
  );
  const issues = entries
    .map((entry) => entry.issue)
    .filter((issue): issue is string => issue !== null);
  const evidence: Phase6Evidence = {
    preflight: entries[0]?.record ?? null,
    deployment: entries[1]?.record ?? null,
    status: entries[2]?.record ?? null,
    verification: entries[3]?.record ?? null,
    openclaw: entries[4]?.record ?? null,
    issues,
  };
  const report = buildPhase6AcceptanceReport(evidence);
  await mkdir(dirname(reportJsonPath), { recursive: true });
  await Promise.all([
    writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 }),
    writeFile(reportMarkdownPath, renderMarkdown(report), { mode: 0o644 }),
  ]);
  const status = safeString(report["status"]) ?? "FAIL";
  console.log(`AgentNest Phase 6 acceptance report: ${status}`);
  console.log("JSON: artifacts/reports/phase-6-summary.json");
  if (status !== "PASS") {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown report failure";
    console.error(`AgentNest Phase 6 report failed: ${message}`);
    process.exitCode = 1;
  });
}
