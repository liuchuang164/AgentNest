import {
  createRuntimeInstanceId,
  deriveLogicalAgentId,
  normalizeTenantBizScope,
} from "@agentnest/capability";
import { describe, expect, it } from "vitest";

describe("tenant/biz identity", () => {
  it("derives a stable logical ID from the normalized scope", () => {
    const canonical = deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    expect(deriveLogicalAgentId({ tenantId: " tenant_A ", bizDomain: "legal" })).toBe(canonical);
    expect(canonical).toMatch(/^tb_[a-f0-9]{20}$/);
  });

  it("changes the ID when either tenant or business domain changes", () => {
    const legal = deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    expect(deriveLogicalAgentId({ tenantId: "tenant_B", bizDomain: "LEGAL" })).not.toBe(legal);
    expect(deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "ROBOT_DOG" })).not.toBe(legal);
  });

  it("rejects path and control characters before identity derivation", () => {
    for (const tenantId of ["../tenant_A", "/tenant_A", "tenant/A", "tenant\\A", "tenant\nA"]) {
      expect(() => normalizeTenantBizScope({ tenantId, bizDomain: "LEGAL" })).toThrow(TypeError);
    }
  });

  it("creates a new runtime ID for every activation candidate", () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    expect(createRuntimeInstanceId(() => ids.shift() ?? "missing")).toBe(
      "ari_11111111-1111-4111-8111-111111111111",
    );
    expect(createRuntimeInstanceId(() => ids.shift() ?? "missing")).toBe(
      "ari_22222222-2222-4222-8222-222222222222",
    );
  });
});
