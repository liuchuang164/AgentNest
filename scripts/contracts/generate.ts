import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openApiDocument, schemaArtifacts } from "@agentnest/contracts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checkOnly = process.argv.includes("--check");
const draft202012 = "https://json-schema.org/draft/2020-12/schema";

interface GeneratedArtifact {
  readonly path: string;
  readonly value: unknown;
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

const artifacts: GeneratedArtifact[] = schemaArtifacts.map(({ fileName, schema }) => ({
  path: resolve(workspaceRoot, "schemas", fileName),
  value: { $schema: draft202012, ...schema },
}));
artifacts.push({
  path: resolve(workspaceRoot, "openapi", "agentnest.openapi.json"),
  value: openApiDocument,
});

let driftDetected = false;
for (const artifact of artifacts) {
  const expected = serialized(artifact.value);
  if (checkOnly) {
    const current = await readExisting(artifact.path);
    if (current !== expected) {
      driftDetected = true;
      console.error(`generated contract is stale: ${artifact.path}`);
    }
    continue;
  }

  await mkdir(dirname(artifact.path), { recursive: true });
  await writeFile(artifact.path, expected, { encoding: "utf8", mode: 0o644 });
  console.log(`generated ${artifact.path}`);
}

if (driftDetected) {
  process.exitCode = 1;
}
