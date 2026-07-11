export interface RuntimeCapabilityContext {
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly capabilitySnapshotId: string;
  readonly allowedToolActions: Readonly<Record<string, readonly string[]>>;
}

export interface RuntimeCapabilityContextProvider {
  resolve(agentId: string, sessionId: string): Promise<RuntimeCapabilityContext>;
}
