import { describe, expect, it } from "vitest";

import { isIdleExpired, MutableTestClock } from "../../packages/test-support/src/index.js";

describe("injected lifecycle clock", () => {
  const initialTime = new Date("2030-01-01T00:00:00.000Z");

  it("honors TTL - 1ms, TTL, and TTL + 1ms boundaries without sleeping", () => {
    const clock = new MutableTestClock(initialTime);
    const ttlMs = 3_600_000;

    clock.advance(ttlMs - 1);
    expect(isIdleExpired(initialTime, ttlMs, clock)).toBe(false);

    clock.advance(1);
    expect(isIdleExpired(initialTime, ttlMs, clock)).toBe(true);

    clock.advance(1);
    expect(isIdleExpired(initialTime, ttlMs, clock)).toBe(true);
  });

  it("returns immutable Date values and can reset deterministically", () => {
    const clock = new MutableTestClock(initialTime);
    const observed = clock.now();
    observed.setUTCFullYear(2040);
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");

    clock.advance(1_000);
    clock.reset();
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  it("rejects invalid clock and TTL values", () => {
    expect(() => new MutableTestClock(new Date("invalid"))).toThrow(RangeError);
    const clock = new MutableTestClock(initialTime);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => isIdleExpired(initialTime, -1, clock)).toThrow(RangeError);
  });
});
