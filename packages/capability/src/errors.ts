export class CapabilityConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CapabilityConfigurationError";
  }
}

export class UnknownTenantBizScopeError extends Error {
  public constructor(tenantId: string, bizDomain: string) {
    super(`tenant capability profile is not configured for ${tenantId}:${bizDomain}`);
    this.name = "UnknownTenantBizScopeError";
  }
}

export class UnknownTaskTemplateError extends Error {
  public constructor(taskType: string) {
    super(`task template is not configured: ${taskType}`);
    this.name = "UnknownTaskTemplateError";
  }
}

export class CapabilityEscalationError extends Error {
  public constructor(kind: "skill" | "tool" | "action" | "memory", value: string) {
    super(`L2 ${kind} is outside the L1 capability profile: ${value}`);
    this.name = "CapabilityEscalationError";
  }
}
