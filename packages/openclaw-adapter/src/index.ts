export interface OpenClawAgentProfileSpec {
  readonly agentId: string;
  readonly logicalAgentId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly skills: readonly string[];
  readonly tools: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
  readonly sandbox: {
    readonly mode: "all";
    readonly scope: "agent";
  };
  readonly capabilitySnapshotId: string;
}

export interface ObservedOpenClawProfile extends OpenClawAgentProfileSpec {
  readonly observedAt: Date;
}

export interface OpenClawConfigAdapter {
  ensureProfile(spec: OpenClawAgentProfileSpec): Promise<ObservedOpenClawProfile>;
  deactivateProfile(agentId: string): Promise<void>;
  inspectProfile(agentId: string): Promise<ObservedOpenClawProfile | null>;
}
