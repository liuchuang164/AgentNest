import type { CapabilityProfile, TenantBizScope } from "@agentnest/contracts";

import {
  CapabilityConfigurationError,
  UnknownTaskTemplateError,
  UnknownTenantBizScopeError,
} from "./errors.js";
import { normalizeTenantBizScope } from "./identity.js";
import type { TaskTemplate, TenantCapabilityCatalog } from "./types.js";

const CREATED_AT = "2026-07-11T00:00:00.000Z";
const DEFAULT_LIFECYCLE = Object.freeze({
  l1_idle_ttl_seconds: 86_400,
  l2_idle_ttl_seconds: 3_600,
  max_active_l2: 5,
});

const PROFILES: readonly CapabilityProfile[] = [
  {
    profile_id: "cap_tenant_a_legal_v1",
    version: 1,
    tenant_id: "tenant_A",
    biz_domain: "LEGAL",
    skills: ["legal-evidence-check"],
    tools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
      legal_research_query: ["query"],
    },
    memory_scopes: ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
    lifecycle: DEFAULT_LIFECYCLE,
    created_at: CREATED_AT,
  },
  {
    profile_id: "cap_tenant_a_robot_dog_v1",
    version: 1,
    tenant_id: "tenant_A",
    biz_domain: "ROBOT_DOG",
    skills: ["robot-dog-health-check"],
    tools: {
      robot_device_read: ["read"],
      robot_health_write: ["write"],
      robot_telemetry_enrich: ["query"],
    },
    memory_scopes: ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
    lifecycle: DEFAULT_LIFECYCLE,
    created_at: CREATED_AT,
  },
  {
    profile_id: "cap_tenant_b_legal_v1",
    version: 1,
    tenant_id: "tenant_B",
    biz_domain: "LEGAL",
    skills: ["legal-evidence-check"],
    tools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
      legal_research_query: ["query"],
    },
    memory_scopes: ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
    lifecycle: DEFAULT_LIFECYCLE,
    created_at: CREATED_AT,
  },
];

const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    taskType: "LEGAL_EVIDENCE_CHECK",
    bizDomain: "LEGAL",
    skills: ["legal-evidence-check"],
    tools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
      legal_research_query: ["query"],
    },
    memoryScopes: ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
  },
  {
    taskType: "ROBOT_DOG_HEALTH_CHECK",
    bizDomain: "ROBOT_DOG",
    skills: ["robot-dog-health-check"],
    tools: {
      robot_device_read: ["read"],
      robot_health_write: ["write"],
      robot_telemetry_enrich: ["query"],
    },
    memoryScopes: ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
  },
];

function profileKey(scope: TenantBizScope): string {
  const normalized = normalizeTenantBizScope(scope);
  return `${normalized.tenantId}:${normalized.bizDomain}`;
}

function cloneProfile(profile: CapabilityProfile): CapabilityProfile {
  return structuredClone(profile);
}

function validateCatalog(): void {
  const keys = new Set<string>();
  for (const profile of PROFILES) {
    const key = profileKey({ tenantId: profile.tenant_id, bizDomain: profile.biz_domain });
    if (keys.has(key)) {
      throw new CapabilityConfigurationError(`duplicate tenant capability profile: ${key}`);
    }
    keys.add(key);
  }
  const taskTypes = new Set<string>();
  for (const template of TASK_TEMPLATES) {
    if (taskTypes.has(template.taskType)) {
      throw new CapabilityConfigurationError(`duplicate task template: ${template.taskType}`);
    }
    taskTypes.add(template.taskType);
  }
}

validateCatalog();

const profilesByScope = new Map(
  PROFILES.map((profile) => [
    profileKey({ tenantId: profile.tenant_id, bizDomain: profile.biz_domain }),
    profile,
  ]),
);
const templatesByTaskType = new Map(
  TASK_TEMPLATES.map((template) => [template.taskType, template]),
);

export class DemoTenantCapabilityCatalog implements TenantCapabilityCatalog {
  public resolveProfile(scope: TenantBizScope): Promise<CapabilityProfile> {
    const profile = profilesByScope.get(profileKey(scope));
    if (profile === undefined) {
      return Promise.reject(new UnknownTenantBizScopeError(scope.tenantId, scope.bizDomain));
    }
    return Promise.resolve(cloneProfile(profile));
  }

  public resolveTaskTemplate(taskType: string): Promise<TaskTemplate> {
    const template = templatesByTaskType.get(taskType);
    if (template === undefined) {
      return Promise.reject(new UnknownTaskTemplateError(taskType));
    }
    return Promise.resolve(structuredClone(template));
  }
}

export const demoCapabilityProfiles: readonly CapabilityProfile[] = PROFILES.map(cloneProfile);
export const demoTaskTemplates: readonly TaskTemplate[] = TASK_TEMPLATES.map((template) =>
  structuredClone(template),
);
