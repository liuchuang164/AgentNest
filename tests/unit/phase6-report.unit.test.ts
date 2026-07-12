import { describe, expect, it } from "vitest";

import {
  buildPhase6AcceptanceReport,
  type Phase6Evidence,
} from "../../scripts/report/phase6-report.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function passingEvidence(): Phase6Evidence {
  return {
    preflight: {
      schema_version: "1.0",
      read_only: true,
      ssh: { connected: true },
      blockers: [],
    },
    deployment: {
      schema_version: "1.0",
      status: "PASS",
      successful_deploy_count: 2,
      agentnest_commit: "a".repeat(40),
      services: ["postgres", "control-plane", "data-gateway-mock", "external-gateway-mock"],
      bindings: "loopback_or_private",
      openclaw_version: "OpenClaw 2030.1.1",
    },
    status: { schema_version: "1.0", status: "PASS" },
    verification: {
      schema_version: "1.0",
      status: "PASS",
      platform_passed: true,
      isolation_tests: [
        { name: "three_scope_memory", status: "PASS", evidence: "reports/memory.json" },
      ],
    },
    openclaw: {
      schema_version: "1.0",
      status: "PASS",
      openclaw: { observed_version: "2030.1.1" },
      official_stable: { version: "2030.1.1" },
    },
    issues: [],
  };
}

describe("Phase 6 acceptance report", () => {
  it("marks a complete evidence set PASS without changing the real/fake claims", () => {
    const report = buildPhase6AcceptanceReport(passingEvidence(), NOW);
    expect(report).toMatchObject({
      status: "PASS",
      completed: true,
      claims: {
        deterministic_test_e2e: "LOCAL_FAKE_OPENCLAW_TRANSPORT",
        remote_openclaw_chain: "VERIFIED",
      },
    });
    expect(report["tests"]).toEqual([
      {
        category: "isolation_tests",
        name: "three_scope_memory",
        status: "PASS",
        evidence: "reports/memory.json",
      },
    ]);
  });

  it("returns INCOMPLETE when required generated evidence is absent", () => {
    const evidence = passingEvidence();
    const report = buildPhase6AcceptanceReport(
      { ...evidence, deployment: null, issues: ["deployment evidence missing"] },
      NOW,
    );
    expect(report).toMatchObject({ status: "INCOMPLETE", completed: false });
  });

  it("preserves the provider blocker classification only when platform evidence passed", () => {
    const evidence = passingEvidence();
    const report = buildPhase6AcceptanceReport(
      {
        ...evidence,
        verification: {
          schema_version: "1.0",
          status: "BLOCKED_EXTERNAL",
          platform_passed: true,
        },
        openclaw: {
          schema_version: "1.0",
          status: "BLOCKED_EXTERNAL",
          external_blocker: { provider: "qwen", code: "Arrearage", http_status: 400 },
        },
      },
      NOW,
    );
    expect(report).toMatchObject({
      status: "BLOCKED_EXTERNAL",
      completed: false,
      external_blocker: { provider: "qwen", code: "Arrearage", http_status: 400 },
    });
  });
});
