import {
  CapabilityEscalationError,
  assertRequestedCapabilityAllowed,
  assertSubset,
  demoCapabilityProfiles,
  demoTaskTemplates,
  intersectForTask,
  type EffectiveTaskCapability,
  type TaskTemplate,
} from "@agentnest/capability";
import { describe, expect, it } from "vitest";

describe("L2 capability intersection", () => {
  const parent = demoCapabilityProfiles.find(
    (profile) => profile.tenant_id === "tenant_A" && profile.biz_domain === "LEGAL",
  );
  if (parent === undefined) {
    throw new Error("tenant_A LEGAL profile fixture is missing");
  }

  it("uses intersection and never unions a foreign skill, tool, action, or memory scope", () => {
    const template: TaskTemplate = {
      taskType: "MIXED_TEST_TEMPLATE",
      bizDomain: "LEGAL",
      skills: ["legal-evidence-check", "robot-dog-health-check"],
      tools: {
        legal_case_read: ["read", "write"],
        legal_analysis_write: ["write"],
        robot_device_read: ["read"],
      },
      memoryScopes: ["RESOURCE_MEMORY", "GLOBAL_MEMORY"],
    };
    const effective = intersectForTask(parent, template);
    expect(effective).toEqual({
      skills: ["legal-evidence-check"],
      tools: {
        legal_analysis_write: ["write"],
        legal_case_read: ["read"],
      },
      memoryScopes: ["RESOURCE_MEMORY"],
    });
    expect(() => {
      assertSubset(effective, parent);
    }).not.toThrow();
  });

  it("returns no capability when the task template belongs to another business domain", () => {
    const robotTemplate = demoTaskTemplates.find(
      (template) => template.taskType === "ROBOT_DOG_HEALTH_CHECK",
    );
    if (robotTemplate === undefined) {
      throw new Error("ROBOT_DOG task template fixture is missing");
    }
    expect(intersectForTask(parent, robotTemplate)).toEqual({
      skills: [],
      tools: {},
      memoryScopes: [],
    });
  });

  it("rejects an explicit L2 capability request that exceeds its parent", () => {
    const escalations: readonly EffectiveTaskCapability[] = [
      {
        skills: ["unknown-skill"],
        tools: {},
        memoryScopes: [],
      },
      {
        skills: [],
        tools: { unknown_tool: ["read"] },
        memoryScopes: [],
      },
      {
        skills: ["legal-evidence-check"],
        tools: { legal_case_read: ["write"] },
        memoryScopes: ["TENANT_BIZ_MEMORY"],
      },
      {
        skills: [],
        tools: {},
        memoryScopes: ["GLOBAL_MEMORY"],
      },
    ];
    for (const escalated of escalations) {
      expect(() => {
        assertRequestedCapabilityAllowed(escalated, parent);
      }).toThrow(CapabilityEscalationError);
    }
  });
});
