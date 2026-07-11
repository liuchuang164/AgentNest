import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../packages/test-support/src/index.js";

describe("recursive secret redaction", () => {
  it("redacts sensitive keys through nested objects and arrays", () => {
    const redacted = redactSecrets({
      password: "sensitive-value",
      nested: [{ api_key: "test-value", safe: "visible" }],
      authorization: "Bearer sensitive-value",
    });

    expect(redacted).toEqual({
      password: "[REDACTED]",
      nested: [{ api_key: "[REDACTED]", safe: "visible" }],
      authorization: "[REDACTED]",
    });
  });

  it("redacts bearer and capability values embedded in free-form strings", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSecrets("Authorization: Capability abc.def.ghi")).toBe(
      "Authorization: Capability [REDACTED]",
    );
  });

  it("does not recurse forever on circular input", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(redactSecrets(circular)).toEqual({ self: "[CIRCULAR]" });
  });
});
