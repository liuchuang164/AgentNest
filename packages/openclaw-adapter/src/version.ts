import { OpenClawVersionError } from "./errors.js";
import type { ParsedOpenClawVersion } from "./types.js";

const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const VERSION_OUTPUT = /^(?:OpenClaw\s+)?(\d+\.\d+\.\d+)(?:\s+\(([0-9a-f]{7,40})\))?$/iu;
const PRERELEASE_MARKER = /(?:^|[.\-+])(alpha|beta|rc|dev)(?:[.\-+]|\d|$)/iu;

export function assertStableVersionString(version: string): void {
  if (!STABLE_VERSION.test(version)) {
    throw new OpenClawVersionError(`expected an exact stable version, received ${version}`);
  }
}

export function parseOpenClawVersion(output: string): ParsedOpenClawVersion {
  const raw = output.trim();
  if (PRERELEASE_MARKER.test(raw)) {
    throw new OpenClawVersionError("OpenClaw prerelease builds are not allowed");
  }
  const match = VERSION_OUTPUT.exec(raw);
  if (match === null) {
    throw new OpenClawVersionError("OpenClaw version output was not an exact stable version");
  }
  const version = match[1];
  if (version === undefined) {
    throw new OpenClawVersionError("OpenClaw version output did not include a version");
  }
  return {
    version,
    commit: match[2] ?? null,
    raw,
  };
}

export function assertExpectedOpenClawVersion(
  output: string,
  expectedVersion: string,
): ParsedOpenClawVersion {
  assertStableVersionString(expectedVersion);
  const parsed = parseOpenClawVersion(output);
  if (parsed.version !== expectedVersion) {
    throw new OpenClawVersionError(
      `expected OpenClaw ${expectedVersion}, observed ${parsed.version}`,
    );
  }
  return parsed;
}
