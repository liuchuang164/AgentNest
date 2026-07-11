export const OPENCLAW_2026_6_11 = "2026.6.11";

export type OpenClawToolProfile = "minimal" | "coding" | "messaging" | "full";
export type OpenClawDelegationMode = "suggest" | "prefer";
export type OpenClawSandboxMode = "off" | "non-main" | "all";
export type OpenClawSandboxScope = "session" | "agent" | "shared";
export type OpenClawWorkspaceAccess = "none" | "ro" | "rw";

export interface OpenClawModelSelection {
  readonly primary: string;
  readonly fallbacks?: readonly string[];
}

export type OpenClawModelSpec = string | OpenClawModelSelection;

export interface OpenClawToolPolicy {
  readonly profile?: OpenClawToolProfile;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

export interface OpenClawSubagentPolicy {
  readonly allowAgents: readonly string[];
  readonly delegationMode?: OpenClawDelegationMode;
  readonly model?: OpenClawModelSpec;
  readonly thinking?: string;
  readonly requireAgentId?: boolean;
}

export interface OpenClawSandboxPolicy {
  readonly mode: OpenClawSandboxMode;
  readonly scope: OpenClawSandboxScope;
  readonly workspaceAccess: OpenClawWorkspaceAccess;
}

/**
 * AgentNest-owned fields from the OpenClaw 2026.6.11 `agents.list[]` schema.
 *
 * Tenant and business identifiers deliberately do not live in this object: OpenClaw does not
 * define those config keys. They remain authoritative in AgentNest's tenant/runtime registry.
 */
export interface OpenClawAgentProfileSpec {
  readonly agentId: string;
  readonly name?: string;
  readonly default?: boolean;
  readonly workspace: string;
  readonly agentDir: string;
  readonly model?: OpenClawModelSpec;
  readonly skills: readonly string[];
  readonly tools: OpenClawToolPolicy;
  readonly subagents: OpenClawSubagentPolicy;
  readonly sandbox?: OpenClawSandboxPolicy;
}

export interface ObservedOpenClawToolPolicy {
  readonly profile: OpenClawToolProfile | null;
  readonly allow: readonly string[] | null;
  readonly deny: readonly string[] | null;
}

export interface ObservedOpenClawSubagentPolicy {
  readonly allowAgents: readonly string[] | null;
  readonly delegationMode: OpenClawDelegationMode | null;
  readonly model: OpenClawModelSpec | null;
  readonly thinking: string | null;
  readonly requireAgentId: boolean | null;
}

export interface ObservedOpenClawSandboxPolicy {
  readonly mode: OpenClawSandboxMode | null;
  readonly scope: OpenClawSandboxScope | null;
  readonly workspaceAccess: OpenClawWorkspaceAccess | null;
}

export interface ObservedOpenClawProfile {
  readonly agentId: string;
  readonly name: string | null;
  readonly default: boolean | null;
  readonly workspace: string | null;
  readonly agentDir: string | null;
  readonly model: OpenClawModelSpec | null;
  readonly skills: readonly string[] | null;
  readonly tools: ObservedOpenClawToolPolicy | null;
  readonly subagents: ObservedOpenClawSubagentPolicy | null;
  readonly sandbox: ObservedOpenClawSandboxPolicy | null;
  readonly observedAt: Date;
  readonly rawConfig: Readonly<Record<string, unknown>>;
}

export interface OpenClawCommandRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface OpenClawCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OpenClawCommandRunner {
  run(request: OpenClawCommandRequest): Promise<OpenClawCommandResult>;
}

export interface ParsedOpenClawVersion {
  readonly version: string;
  readonly commit: string | null;
  readonly raw: string;
}

export interface DispatchToAgentInput {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly message: string;
  readonly idempotencyKey: string;
  readonly timeoutMs?: number;
  readonly agentTimeoutSeconds?: number;
}

export interface SpawnTaskAgentInput {
  readonly l1AgentId: string;
  readonly l1SessionKey: string;
  readonly childAgentId: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly task: string;
  readonly idempotencyKey: string;
  readonly timeoutMs?: number;
}

export interface OpenClawAgentRunResult {
  readonly runId: string | null;
  readonly status: string | null;
  readonly sessionKey: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface OpenClawAdapter {
  verifyStableVersion(): Promise<ParsedOpenClawVersion>;
  ensureProfile(spec: OpenClawAgentProfileSpec): Promise<ObservedOpenClawProfile>;
  deactivateProfile(agentId: string): Promise<void>;
  inspectProfile(agentId: string): Promise<ObservedOpenClawProfile | null>;
  dispatchToAgent(input: DispatchToAgentInput): Promise<OpenClawAgentRunResult>;
  spawnTaskAgent(input: SpawnTaskAgentInput): Promise<OpenClawAgentRunResult>;
}
