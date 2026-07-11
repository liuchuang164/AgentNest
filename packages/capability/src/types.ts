import type { CapabilityProfile, LifecyclePolicy, TenantBizScope } from "@agentnest/contracts";

export type ToolActions = Readonly<Record<string, readonly string[]>>;

export interface TaskTemplate {
  readonly taskType: string;
  readonly bizDomain: string;
  readonly skills: readonly string[];
  readonly tools: ToolActions;
  readonly memoryScopes: readonly string[];
}

export interface EffectiveTaskCapability {
  readonly skills: readonly string[];
  readonly tools: ToolActions;
  readonly memoryScopes: readonly string[];
}

export interface TenantCapabilityCatalog {
  resolveProfile(scope: TenantBizScope): Promise<CapabilityProfile>;
  resolveTaskTemplate(taskType: string): Promise<TaskTemplate>;
}

export type { CapabilityProfile, LifecyclePolicy, TenantBizScope };
