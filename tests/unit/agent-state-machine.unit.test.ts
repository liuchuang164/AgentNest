import { L1RuntimeStatus, L2TaskStatus } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import {
  assertL1Transition,
  assertL2Transition,
  InvalidStateTransitionError,
  isL1TransitionAllowed,
  isL2TransitionAllowed,
} from "../../apps/control-plane/src/domain/agent-state-machine.js";

describe("explicit agent state machines", () => {
  it("permits the checkpoint-before-unload L1 path", () => {
    expect(isL1TransitionAllowed(L1RuntimeStatus.IDLE, L1RuntimeStatus.CHECKPOINTING)).toBe(true);
    expect(isL1TransitionAllowed(L1RuntimeStatus.CHECKPOINTING, L1RuntimeStatus.UNLOADING)).toBe(
      true,
    );
    expect(isL1TransitionAllowed(L1RuntimeStatus.UNLOADING, L1RuntimeStatus.DESTROYED)).toBe(true);
  });

  it("forbids destroying an active L1 without checkpointing", () => {
    expect(isL1TransitionAllowed(L1RuntimeStatus.ACTIVE, L1RuntimeStatus.DESTROYED)).toBe(false);
    expect(() => {
      assertL1Transition(L1RuntimeStatus.ACTIVE, L1RuntimeStatus.DESTROYED);
    }).toThrow(InvalidStateTransitionError);
  });

  it("keeps checkpoint failure recoverable and never terminal", () => {
    expect(
      isL1TransitionAllowed(L1RuntimeStatus.CHECKPOINTING, L1RuntimeStatus.CHECKPOINT_FAILED),
    ).toBe(true);
    expect(
      isL1TransitionAllowed(L1RuntimeStatus.CHECKPOINT_FAILED, L1RuntimeStatus.DESTROYED),
    ).toBe(false);
    expect(
      isL1TransitionAllowed(L1RuntimeStatus.CHECKPOINT_FAILED, L1RuntimeStatus.CHECKPOINTING),
    ).toBe(false);
  });

  it("requires failed unloads to return to IDLE before retrying", () => {
    expect(isL1TransitionAllowed(L1RuntimeStatus.UNLOAD_FAILED, L1RuntimeStatus.IDLE)).toBe(true);
    expect(isL1TransitionAllowed(L1RuntimeStatus.UNLOAD_FAILED, L1RuntimeStatus.UNLOADING)).toBe(
      false,
    );
  });

  it("requires L2 checkpoint before archive", () => {
    expect(isL2TransitionAllowed(L2TaskStatus.COMPLETED, L2TaskStatus.CHECKPOINTED)).toBe(true);
    expect(isL2TransitionAllowed(L2TaskStatus.COMPLETED, L2TaskStatus.ARCHIVED)).toBe(false);
    expect(() => {
      assertL2Transition(L2TaskStatus.COMPLETED, L2TaskStatus.ARCHIVED);
    }).toThrow(InvalidStateTransitionError);
  });

  it("supports freezing an L2 that is waiting for input", () => {
    expect(isL2TransitionAllowed(L2TaskStatus.WAITING_INPUT, L2TaskStatus.CHECKPOINTED)).toBe(true);
    expect(() => {
      assertL2Transition(L2TaskStatus.WAITING_INPUT, L2TaskStatus.CHECKPOINTED);
    }).not.toThrow();
  });
});
