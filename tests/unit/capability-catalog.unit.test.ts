import {
  DemoTenantCapabilityCatalog,
  UnknownTaskTemplateError,
  UnknownTenantBizScopeError,
  demoCapabilityProfiles,
} from "@agentnest/capability";
import { describe, expect, it } from "vitest";

describe("Demo tenant capability catalog", () => {
  const catalog = new DemoTenantCapabilityCatalog();

  it("contains exactly the three required tenant/biz scopes", () => {
    expect(
      demoCapabilityProfiles
        .map(({ tenant_id, biz_domain }) => `${tenant_id}:${biz_domain}`)
        .sort(),
    ).toEqual(["tenant_A:LEGAL", "tenant_A:ROBOT_DOG", "tenant_B:LEGAL"]);
  });

  it("keeps LEGAL and ROBOT_DOG skills and tools isolated", async () => {
    const legal = await catalog.resolveProfile({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    const robot = await catalog.resolveProfile({ tenantId: "tenant_A", bizDomain: "ROBOT_DOG" });
    expect(legal.skills).toEqual(["legal-evidence-check"]);
    expect(Object.keys(legal.tools).sort()).toEqual([
      "legal_analysis_write",
      "legal_case_read",
      "legal_research_query",
    ]);
    expect(robot.skills).toEqual(["robot-dog-health-check"]);
    expect(Object.keys(robot.tools).every((tool) => tool.startsWith("robot_"))).toBe(true);
  });

  it("returns isolated copies and rejects unknown scope/template values", async () => {
    const first = await catalog.resolveProfile({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    first.skills.push("mutation-attempt");
    expect(
      (await catalog.resolveProfile({ tenantId: "tenant_A", bizDomain: "LEGAL" })).skills,
    ).toEqual(["legal-evidence-check"]);
    await expect(
      catalog.resolveProfile({ tenantId: "tenant_C", bizDomain: "LEGAL" }),
    ).rejects.toThrow(UnknownTenantBizScopeError);
    await expect(catalog.resolveTaskTemplate("UNKNOWN_TASK")).rejects.toThrow(
      UnknownTaskTemplateError,
    );
  });
});
