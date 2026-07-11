import { mkdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const scanner = resolve("node_modules/.bin/tsx");
const scannerArguments = ["scripts/verify/secret-scan.ts"] as const;

function runScanner(): ReturnType<typeof spawnSync> {
  return spawnSync(scanner, scannerArguments, {
    cwd: resolve("."),
    encoding: "utf8",
    shell: false,
  });
}

describe("repository and artifact secret scan", () => {
  it("passes for the repository baseline without reading ignored config.txt", () => {
    const result = runScanner();
    expect(result.status).toBe(0);
  });

  it("scans ignored artifacts, fails closed, and never echoes the matched value", async () => {
    const artifactDirectory = resolve("artifacts/raw");
    const artifactPath = resolve(artifactDirectory, "secret-scan-fixture.txt");
    const sentinel = ["fixture", "credential", "must", "not", "leak"].join("-");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(artifactPath, `password=${sentinel}\n`, { encoding: "utf8", mode: 0o600 });

    try {
      const result = runScanner();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("artifacts/raw/secret-scan-fixture.txt");
      expect(result.stderr).not.toContain(sentinel);
      expect(result.stdout).not.toContain(sentinel);
    } finally {
      await unlink(artifactPath);
    }
  });
});
