import type { RuntimeInstanceRecord } from "@agentnest/persistence";

export class RuntimeCache {
  readonly #active = new Map<string, RuntimeInstanceRecord>();

  public get(logicalAgentId: string): RuntimeInstanceRecord | undefined {
    return this.#active.get(logicalAgentId);
  }

  public set(runtime: RuntimeInstanceRecord): void {
    this.#active.set(runtime.logicalAgentId, runtime);
  }

  public delete(logicalAgentId: string): boolean {
    return this.#active.delete(logicalAgentId);
  }

  public values(): readonly RuntimeInstanceRecord[] {
    return [...this.#active.values()];
  }
}
