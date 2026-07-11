import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { spawnSync } from "node:child_process";

interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
}

interface Violation {
  readonly path: string;
  readonly rule: string;
}

const forbiddenBasenames = new Set(["config.txt", ".env", "id_rsa", "id_ed25519"]);
const forbiddenExtensions = new Set([".pem", ".key", ".p12", ".pfx"]);
const secretRules: readonly SecretRule[] = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "openai-api-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { id: "github-fine-grained-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    id: "assigned-secret",
    pattern:
      /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)[ \t]*[=:][ \t]*["']?[A-Za-z0-9+/=_-]{20,}["']?/i,
  },
];

function enumerateFiles(arguments_: readonly string[]): readonly string[] {
  const result = spawnSync("git", arguments_, {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    console.error("secret scan could not enumerate repository files");
    process.exit(2);
  }
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

async function matchingRules(path: string): Promise<readonly string[]> {
  const matches = new Set<string>();
  let carry = "";
  for await (const chunkValue of createReadStream(path, { highWaterMark: 65_536 })) {
    const chunk: unknown = chunkValue;
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new TypeError("secret scan received an unsupported stream chunk");
    }
    const chunkText = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const text = `${carry}${chunkText}`;
    for (const rule of secretRules) {
      if (rule.pattern.test(text)) {
        matches.add(rule.id);
      }
    }
    carry = text.slice(-1_024);
  }
  return [...matches];
}

const sourceFiles = enumerateFiles([
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
]);
const ignoredArtifactFiles = enumerateFiles([
  "ls-files",
  "-z",
  "--others",
  "--ignored",
  "--exclude-standard",
  "--",
  "artifacts",
]);
const repositoryFiles = [...new Set([...sourceFiles, ...ignoredArtifactFiles])].sort();
const violations: Violation[] = [];

for (const path of repositoryFiles) {
  const fileName = basename(path);
  const extension = extname(fileName).toLowerCase();
  if (
    forbiddenBasenames.has(fileName) ||
    (fileName.startsWith(".env.") && fileName !== ".env.example") ||
    forbiddenExtensions.has(extension)
  ) {
    violations.push({ path, rule: "forbidden-secret-file" });
    continue;
  }

  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    violations.push({ path, rule: "tracked-symlink" });
    continue;
  }
  if (!stat.isFile()) {
    continue;
  }

  for (const rule of await matchingRules(path)) {
    violations.push({ path, rule });
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`secret scan violation: ${violation.path} (${violation.rule})`);
  }
  process.exit(1);
}

console.log(`secret scan passed for ${String(repositoryFiles.length)} repository files`);
