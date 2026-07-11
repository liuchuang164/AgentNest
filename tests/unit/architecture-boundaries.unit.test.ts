import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";

import {
  ScriptTarget,
  SyntaxKind,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  type Node,
} from "typescript";
import { describe, expect, it } from "vitest";

interface BoundaryRule {
  readonly path: string;
  readonly allowedInternalDependencies: readonly string[];
}

interface BoundaryDocument {
  readonly workspaces: Readonly<Record<string, BoundaryRule>>;
}

interface PackageManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

interface WorkspaceInfo {
  readonly name: string;
  readonly root: string;
  readonly allowedInternalDependencies: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseStringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    throw new TypeError("dependency map must contain only string versions");
  }
  const entries = Object.entries(value).map(([key, entry]) => [key, String(entry)] as const);
  return Object.fromEntries(entries);
}

function parseBoundaryDocument(value: unknown): BoundaryDocument {
  if (!isRecord(value) || !isRecord(value["workspaces"])) {
    throw new TypeError("invalid architecture-boundaries.json");
  }

  const workspaces: Record<string, BoundaryRule> = {};
  for (const [name, ruleValue] of Object.entries(value["workspaces"])) {
    if (
      !isRecord(ruleValue) ||
      typeof ruleValue["path"] !== "string" ||
      !isStringArray(ruleValue["allowedInternalDependencies"])
    ) {
      throw new TypeError(`invalid boundary rule for ${name}`);
    }
    workspaces[name] = {
      path: ruleValue["path"],
      allowedInternalDependencies: ruleValue["allowedInternalDependencies"],
    };
  }
  return { workspaces };
}

function parseManifest(value: unknown): PackageManifest {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    throw new TypeError("invalid package manifest");
  }
  const dependencies = parseStringMap(value["dependencies"]);
  const devDependencies = parseStringMap(value["devDependencies"]);
  const peerDependencies = parseStringMap(value["peerDependencies"]);
  const optionalDependencies = parseStringMap(value["optionalDependencies"]);
  return {
    name: value["name"],
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(devDependencies === undefined ? {} : { devDependencies }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(optionalDependencies === undefined ? {} : { optionalDependencies }),
  };
}

async function workspacePackagePaths(): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const root of ["apps", "packages"]) {
    const entries = await readdir(resolve(root), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(`${root}/${entry.name}`);
      }
    }
  }
  return paths.sort();
}

async function typescriptFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await typescriptFiles(path)));
    } else if (entry.isFile() && extname(entry.name) === ".ts") {
      files.push(path);
    }
  }
  return files;
}

function importedSpecifiers(path: string, source: string): readonly string[] {
  const sourceFile = createSourceFile(path, source, ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function workspaceContaining(
  path: string,
  workspaces: readonly WorkspaceInfo[],
): WorkspaceInfo | null {
  return (
    workspaces.find(
      (workspace) => path === workspace.root || path.startsWith(`${workspace.root}${sep}`),
    ) ?? null
  );
}

function internalPackageName(specifier: string): string | null {
  if (!specifier.startsWith("@agentnest/")) {
    return null;
  }
  return specifier.split("/").slice(0, 2).join("/");
}

async function sourceBoundaryViolations(
  boundaryDocument: BoundaryDocument,
): Promise<readonly string[]> {
  const workspaces = Object.entries(boundaryDocument.workspaces).map(([name, rule]) => ({
    name,
    root: resolve(rule.path),
    allowedInternalDependencies: new Set(rule.allowedInternalDependencies),
  }));
  const violations: string[] = [];

  for (const workspace of workspaces) {
    const files = await typescriptFiles(resolve(workspace.root, "src"));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const specifier of importedSpecifiers(file, source)) {
        const importedPackage = internalPackageName(specifier);
        if (
          importedPackage !== null &&
          importedPackage !== workspace.name &&
          !workspace.allowedInternalDependencies.has(importedPackage)
        ) {
          violations.push(`${workspace.name} imports undeclared ${importedPackage}`);
        }

        if (specifier.startsWith(".")) {
          const targetWorkspace = workspaceContaining(
            resolve(dirname(file), specifier),
            workspaces,
          );
          if (targetWorkspace !== null && targetWorkspace.name !== workspace.name) {
            violations.push(
              `${workspace.name} uses a cross-workspace relative import into ${targetWorkspace.name}`,
            );
          }
        }
      }
    }
  }
  return violations;
}

describe("workspace architecture boundaries", () => {
  it("allows only the declared internal dependency direction", async () => {
    const rawBoundaryDocument: unknown = JSON.parse(
      await readFile(resolve("architecture-boundaries.json"), "utf8"),
    );
    const boundaryDocument = parseBoundaryDocument(rawBoundaryDocument);
    const violations: string[] = [];

    for (const [expectedName, rule] of Object.entries(boundaryDocument.workspaces)) {
      const rawManifest: unknown = JSON.parse(
        await readFile(resolve(rule.path, "package.json"), "utf8"),
      );
      const manifest = parseManifest(rawManifest);
      if (manifest.name !== expectedName) {
        violations.push(`${rule.path} must be named ${expectedName}`);
      }

      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
        ...manifest.optionalDependencies,
      };
      const internalDependencies = Object.keys(dependencies)
        .filter((name) => name.startsWith("@agentnest/"))
        .sort();
      const allowed = [...rule.allowedInternalDependencies].sort();
      if (JSON.stringify(internalDependencies) !== JSON.stringify(allowed)) {
        violations.push(`${expectedName} internal dependencies differ from its allowlist`);
      }
    }

    const declaredPaths = Object.values(boundaryDocument.workspaces)
      .map((rule) => rule.path)
      .sort();
    expect(await workspacePackagePaths()).toEqual(declaredPaths);
    violations.push(...(await sourceBoundaryViolations(boundaryDocument)));
    expect(violations).toEqual([]);
  });
});
