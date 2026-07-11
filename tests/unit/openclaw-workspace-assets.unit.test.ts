import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("OpenClaw workspace and skill assets", () => {
  it("ships named, versioned, domain-isolated skills", async () => {
    const legal = await readRepoFile("skills/legal-evidence-check/SKILL.md");
    const robot = await readRepoFile("skills/robot-dog-health-check/SKILL.md");

    expect(legal).toContain("name: legal-evidence-check");
    expect(legal).toContain("Version: `1.0.0`");
    expect(legal).toContain("legal_case_read");
    expect(legal).not.toContain("robot_device_read");

    expect(robot).toContain("name: robot-dog-health-check");
    expect(robot).toContain("Version: `1.0.0`");
    expect(robot).toContain("robot_device_read");
    expect(robot).not.toContain("legal_case_read");
  });

  it("keeps L0 business-neutral and dispatch-only", async () => {
    const main = await readRepoFile("infra/openclaw/workspaces/main/AGENTS.md");

    expect(main).toContain("__L1_ROUTE_TABLE_JSON__");
    expect(main).toContain("sessions_send");
    expect(main).not.toContain("legal-evidence-check");
    expect(main).not.toContain("robot-dog-health-check");
    expect(main).not.toMatch(
      /(?:legal|robot)_(?:case|device|analysis|health|research|telemetry)_/u,
    );
  });

  it.each([
    [
      "LEGAL",
      "infra/openclaw/workspaces/l1-legal/AGENTS.md",
      "LEGAL_EVIDENCE_CHECK",
      "legal",
      "robot_",
    ],
    [
      "ROBOT_DOG",
      "infra/openclaw/workspaces/l1-robot-dog/AGENTS.md",
      "ROBOT_DOG_HEALTH_CHECK",
      "robot",
      "legal_",
    ],
  ])(
    "makes the %s L1 spawn only its fixed isolated L2",
    async (_domain, path, taskType, allowedDomain, forbiddenToolPrefix) => {
      const prompt = await readRepoFile(path);

      expect(prompt).toContain("sessions_spawn");
      expect(prompt).toContain('"agentId": "__L2_AGENT_ID__"');
      expect(prompt).toContain('"context": "isolated"');
      expect(prompt).toContain('"mode": "run"');
      expect(prompt).toContain('"cleanup": "keep"');
      expect(prompt).toContain(taskType);
      expect(prompt).toContain("__TENANT_ID__");
      expect(prompt).toContain("__BIZ_DOMAIN__");
      expect(prompt).toContain("__L1_AGENT_ID__");
      expect(prompt.toLowerCase()).toContain(allowedDomain);
      expect(prompt).not.toContain(forbiddenToolPrefix);
    },
  );

  it("gives both fixed L2 roles an explicit non-fabricated probe marker", async () => {
    const templates = [
      {
        path: "infra/openclaw/workspaces/l2-legal-evidence-check/AGENTS.md",
        marker:
          "AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=LEGAL_EVIDENCE_CHECK|status=CHAIN_OK|role=LEGAL|tool_mode=NOT_RUN",
      },
      {
        path: "infra/openclaw/workspaces/l2-robot-dog-health-check/AGENTS.md",
        marker:
          "AGENTNEST_L2_RESULT|task_id=<task_id>|task_type=ROBOT_DOG_HEALTH_CHECK|status=CHAIN_OK|role=ROBOT_DOG|tool_mode=NOT_RUN",
      },
    ];

    for (const { path, marker } of templates) {
      const prompt = await readRepoFile(path);
      expect(prompt).toContain("phase3_chain_probe=true");
      expect(prompt).toContain(marker);
      expect(prompt).toContain("not evidence that a business tool ran");
      expect(prompt).toContain("__L2_AGENT_ID__");
    }
  });
});
