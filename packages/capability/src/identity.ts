import { createHash, randomUUID } from "node:crypto";

import type { TenantBizScope } from "@agentnest/contracts";

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BIZ_DOMAIN_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface NormalizedTenantBizScope {
  readonly tenantId: string;
  readonly bizDomain: string;
}

export function normalizeTenantBizScope(scope: TenantBizScope): NormalizedTenantBizScope {
  const tenantId = scope.tenantId.normalize("NFKC").trim();
  const bizDomain = scope.bizDomain.normalize("NFKC").trim().toUpperCase();
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError("tenant_id must contain only letters, numbers, underscore, or hyphen");
  }
  if (!BIZ_DOMAIN_PATTERN.test(bizDomain)) {
    throw new TypeError("biz_domain must be an uppercase identifier");
  }
  return { tenantId, bizDomain };
}

export function deriveLogicalAgentId(scope: TenantBizScope): string {
  const normalized = normalizeTenantBizScope(scope);
  const digest = createHash("sha256")
    .update(`${normalized.tenantId}:${normalized.bizDomain}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `tb_${digest}`;
}

export function createRuntimeInstanceId(createUuid: () => string = randomUUID): string {
  return `ari_${createUuid()}`;
}
