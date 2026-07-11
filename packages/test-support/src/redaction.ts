const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const CAPABILITY_VALUE = /\bCapability\s+[A-Za-z0-9._~+/=-]+/gi;

function redactString(value: string): string {
  return value
    .replace(BEARER_VALUE, `Bearer ${REDACTED}`)
    .replace(CAPABILITY_VALUE, `Capability ${REDACTED}`);
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return CIRCULAR;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactInternal(entry, seen));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactInternal(entry, seen);
  }
  return result;
}

export function redactSecrets(value: unknown): unknown {
  return redactInternal(value, new WeakSet<object>());
}
