export interface ToolActionGrant {
  readonly toolName: string;
  readonly actions: readonly string[];
}

export interface EffectiveCapability {
  readonly skills: readonly string[];
  readonly tools: readonly ToolActionGrant[];
  readonly memoryScopes: readonly string[];
  readonly dataScopes: readonly string[];
}
