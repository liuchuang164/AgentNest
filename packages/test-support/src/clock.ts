export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export class MutableTestClock implements Clock {
  readonly #initialTimestampMs: number;
  #currentTimestampMs: number;

  public constructor(initialTime: Date) {
    const timestamp = initialTime.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("initial test-clock time must be valid");
    }
    this.#initialTimestampMs = timestamp;
    this.#currentTimestampMs = timestamp;
  }

  public now(): Date {
    return new Date(this.#currentTimestampMs);
  }

  public advance(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
      throw new RangeError("test-clock duration must be a non-negative safe integer");
    }
    this.#currentTimestampMs += durationMs;
  }

  public reset(): void {
    this.#currentTimestampMs = this.#initialTimestampMs;
  }
}

export function isIdleExpired(lastActiveAt: Date, ttlMs: number, clock: Clock): boolean {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new RangeError("TTL must be a non-negative safe integer");
  }

  const lastActiveTimestamp = lastActiveAt.getTime();
  if (!Number.isFinite(lastActiveTimestamp)) {
    throw new RangeError("last-active time must be valid");
  }

  return clock.now().getTime() - lastActiveTimestamp >= ttlMs;
}
