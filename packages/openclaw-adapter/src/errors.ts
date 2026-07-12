export class OpenClawAdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenClawAdapterError";
  }
}

export class OpenClawVersionError extends OpenClawAdapterError {
  public constructor(message: string) {
    super(message);
    this.name = "OpenClawVersionError";
  }
}

export class OpenClawCommandError extends OpenClawAdapterError {
  public readonly exitCode: number;
  public readonly providerBlocked: boolean;

  public constructor(
    operation: string,
    exitCode: number,
    options: { readonly providerBlocked?: boolean } = {},
  ) {
    super(`${operation} failed with exit code ${String(exitCode)}`);
    this.name = "OpenClawCommandError";
    this.exitCode = exitCode;
    this.providerBlocked = options.providerBlocked === true;
  }
}

export class OpenClawProfileValidationError extends OpenClawAdapterError {
  public constructor(message: string) {
    super(message);
    this.name = "OpenClawProfileValidationError";
  }
}

export class OpenClawObservedStateError extends OpenClawAdapterError {
  public readonly agentId: string;
  public readonly differences: readonly string[];

  public constructor(agentId: string, differences: readonly string[]) {
    super(
      `OpenClaw profile ${agentId} did not converge; differing fields: ${differences.join(", ")}`,
    );
    this.name = "OpenClawObservedStateError";
    this.agentId = agentId;
    this.differences = differences;
  }
}
