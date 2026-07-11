import { L1RuntimeStatus, L2TaskStatus } from "@agentnest/contracts";

const L1_TRANSITIONS: Readonly<Record<L1RuntimeStatus, readonly L1RuntimeStatus[]>> = {
  [L1RuntimeStatus.PROVISIONING]: [L1RuntimeStatus.ACTIVE, L1RuntimeStatus.FAILED],
  [L1RuntimeStatus.ACTIVE]: [L1RuntimeStatus.IDLE],
  [L1RuntimeStatus.IDLE]: [L1RuntimeStatus.ACTIVE, L1RuntimeStatus.CHECKPOINTING],
  [L1RuntimeStatus.CHECKPOINTING]: [L1RuntimeStatus.UNLOADING, L1RuntimeStatus.CHECKPOINT_FAILED],
  [L1RuntimeStatus.CHECKPOINT_FAILED]: [L1RuntimeStatus.ACTIVE, L1RuntimeStatus.IDLE],
  [L1RuntimeStatus.UNLOADING]: [L1RuntimeStatus.UNLOADED, L1RuntimeStatus.UNLOAD_FAILED],
  [L1RuntimeStatus.UNLOAD_FAILED]: [L1RuntimeStatus.IDLE],
  [L1RuntimeStatus.UNLOADED]: [L1RuntimeStatus.PROVISIONING],
  [L1RuntimeStatus.FAILED]: [L1RuntimeStatus.PROVISIONING],
};

const L2_TRANSITIONS: Readonly<Record<L2TaskStatus, readonly L2TaskStatus[]>> = {
  [L2TaskStatus.QUEUED]: [L2TaskStatus.SPAWNING],
  [L2TaskStatus.SPAWNING]: [L2TaskStatus.RUNNING, L2TaskStatus.FAILED],
  [L2TaskStatus.RUNNING]: [L2TaskStatus.WAITING_INPUT, L2TaskStatus.COMPLETED, L2TaskStatus.FAILED],
  [L2TaskStatus.WAITING_INPUT]: [L2TaskStatus.RUNNING, L2TaskStatus.CHECKPOINTED],
  [L2TaskStatus.COMPLETED]: [L2TaskStatus.CHECKPOINTED],
  [L2TaskStatus.FAILED]: [L2TaskStatus.CHECKPOINTED],
  [L2TaskStatus.CHECKPOINTED]: [L2TaskStatus.UNLOADED],
  [L2TaskStatus.UNLOADED]: [],
};

export class InvalidStateTransitionError extends Error {
  public constructor(level: "L1" | "L2", from: string, to: string) {
    super(`${level} state transition is not allowed: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export function isL1TransitionAllowed(from: L1RuntimeStatus, to: L1RuntimeStatus): boolean {
  return L1_TRANSITIONS[from].includes(to);
}

export function assertL1Transition(from: L1RuntimeStatus, to: L1RuntimeStatus): void {
  if (!isL1TransitionAllowed(from, to)) {
    throw new InvalidStateTransitionError("L1", from, to);
  }
}

export function isL2TransitionAllowed(from: L2TaskStatus, to: L2TaskStatus): boolean {
  return L2_TRANSITIONS[from].includes(to);
}

export function assertL2Transition(from: L2TaskStatus, to: L2TaskStatus): void {
  if (!isL2TransitionAllowed(from, to)) {
    throw new InvalidStateTransitionError("L2", from, to);
  }
}
