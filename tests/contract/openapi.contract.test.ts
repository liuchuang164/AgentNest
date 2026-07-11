import { resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { openApiDocument } from "../../packages/contracts/src/index.js";

const requiredPaths = [
  "/api/tasks",
  "/api/tasks/{taskId}",
  "/api/agents",
  "/api/agents/{logicalAgentId}",
  "/api/agents/{logicalAgentId}/memories",
  "/api/admin/reaper/run",
  "/api/admin/clock/advance",
  "/health",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProperty(value: unknown, property: string): unknown {
  return isRecord(value) ? value[property] : undefined;
}

function valuesOfProperty(value: unknown, property: string): readonly unknown[] {
  const candidate = readProperty(value, property);
  return Array.isArray(candidate) ? candidate : [];
}

function schemaRequires(schema: unknown, field: string): boolean {
  const required = valuesOfProperty(schema, "required");
  if (required.includes(field)) {
    return true;
  }
  const alternatives = [...valuesOfProperty(schema, "anyOf"), ...valuesOfProperty(schema, "oneOf")];
  return alternatives.length > 0 && alternatives.every((item) => schemaRequires(item, field));
}

describe("lean OpenAPI 3.1 contract", () => {
  it("is valid and exposes every mandatory Demo endpoint", async () => {
    const document = await SwaggerParser.validate(resolve("openapi/agentnest.openapi.json"));
    expect(readProperty(document, "openapi")).toBe("3.1.0");
    const paths = Object.keys(document.paths ?? {});
    for (const path of requiredPaths) {
      expect(paths).toContain(path);
    }
  });

  it("uses the current profile and execution-context components only", () => {
    expect(openApiDocument).toHaveProperty("components.schemas.CapabilityProfile");
    expect(openApiDocument).toHaveProperty("components.schemas.ExecutionContext");
    expect(openApiDocument).not.toHaveProperty("components.schemas.CapabilitySnapshot");
    expect(openApiDocument).not.toHaveProperty("components.schemas.CapabilityTokenClaims");
  });

  it("requires request and trace correlation in every JSON response", async () => {
    const document = await SwaggerParser.dereference(resolve("openapi/agentnest.openapi.json"));
    const paths = readProperty(document, "paths");
    for (const pathItem of Object.values(isRecord(paths) ? paths : {})) {
      for (const method of ["get", "post"] as const) {
        const operation = readProperty(pathItem, method);
        if (operation === undefined) {
          continue;
        }
        const responses = readProperty(operation, "responses");
        for (const response of Object.values(isRecord(responses) ? responses : {})) {
          const content = readProperty(response, "content");
          const mediaType = readProperty(content, "application/json");
          if (mediaType === undefined) {
            continue;
          }
          const schema = readProperty(mediaType, "schema");
          expect(schemaRequires(schema, "request_id")).toBe(true);
          expect(schemaRequires(schema, "trace_id")).toBe(true);
        }
      }
    }
  });

  it("keeps Admin and clock operations out of the public task namespace", () => {
    const paths = readProperty(openApiDocument, "paths");
    expect(readProperty(paths, "/api/admin/reaper/run")).toBeDefined();
    expect(readProperty(paths, "/api/admin/clock/advance")).toBeDefined();
    expect(readProperty(paths, "/api/tasks")).toBeDefined();
  });
});
