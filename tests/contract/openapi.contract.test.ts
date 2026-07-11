import { resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import {
  L1RuntimeStatus,
  L2TaskStatus,
  openApiDocument,
} from "../../packages/contracts/src/index.js";

const requiredPaths = [
  "/api/v1/tasks",
  "/api/v1/tasks/{taskId}",
  "/api/v1/agents/{logicalAgentId}",
  "/api/v1/admin/agents/{logicalAgentId}/checkpoint",
  "/api/v1/admin/agents/{logicalAgentId}/unload",
  "/api/v1/admin/reaper/run-once",
  "/api/v1/admin/test-clock/advance",
  "/health/live",
  "/health/ready",
  "/metrics",
] as const;

const writePaths = [
  "/api/v1/tasks",
  "/api/v1/admin/agents/{logicalAgentId}/checkpoint",
  "/api/v1/admin/agents/{logicalAgentId}/unload",
  "/api/v1/admin/reaper/run-once",
  "/api/v1/admin/test-clock/advance",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProperty(value: unknown, property: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return Object.entries(value).find(([key]) => key === property)?.[1];
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
  const alternatives = valuesOfProperty(schema, "anyOf");
  return (
    alternatives.length > 0 &&
    alternatives.every((alternative) => schemaRequires(alternative, field))
  );
}

function responseDataObject(componentName: string): unknown {
  const components = readProperty(openApiDocument, "components");
  const schemas = readProperty(components, "schemas");
  const responseSchema = readProperty(schemas, componentName);
  const properties = readProperty(responseSchema, "properties");
  const dataSchema = readProperty(properties, "data");
  return valuesOfProperty(dataSchema, "anyOf").find(
    (candidate) => readProperty(candidate, "type") === "object",
  );
}

function literalValues(schema: unknown): readonly unknown[] {
  return valuesOfProperty(schema, "anyOf").map((candidate) => readProperty(candidate, "const"));
}

describe("OpenAPI 3.1 contract", () => {
  it("is valid and exposes every mandatory endpoint", async () => {
    const document = await SwaggerParser.validate(resolve("openapi/agentnest.openapi.json"));
    expect(readProperty(document, "openapi")).toBe("3.1.0");
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([...requiredPaths].sort());
  });

  it("is generated from the same in-process contract source", () => {
    expect(openApiDocument["openapi"]).toBe("3.1.0");
    expect(openApiDocument).toHaveProperty("components.schemas.TaskRequest");
    expect(openApiDocument).toHaveProperty("components.schemas.CapabilitySnapshot");
    expect(openApiDocument).toHaveProperty("components.schemas.CapabilityTokenClaims");
    expect(openApiDocument).toHaveProperty("components.schemas.AgentState");
    expect(openApiDocument).toHaveProperty("components.schemas.TraceEvent");
  });

  it("requires an idempotency key on every write operation", () => {
    const paths = readProperty(openApiDocument, "paths");
    for (const path of writePaths) {
      const pathItem = readProperty(paths, path);
      const operation = readProperty(pathItem, "post");
      const parameters = readProperty(operation, "parameters");
      expect(Array.isArray(parameters)).toBe(true);
      const names = Array.isArray(parameters)
        ? parameters.map((parameter) => readProperty(parameter, "name"))
        : [];
      expect(names).toContain("Idempotency-Key");
    }
  });

  it("requires request and trace correlation on every operation and response", async () => {
    const document = await SwaggerParser.dereference(resolve("openapi/agentnest.openapi.json"));
    const paths = readProperty(document, "paths");
    for (const pathItem of Object.values(isRecord(paths) ? paths : {})) {
      for (const method of ["get", "post"] as const) {
        const operation = readProperty(pathItem, method);
        if (operation === undefined) {
          continue;
        }

        if (method === "get") {
          const parameterNames = valuesOfProperty(operation, "parameters").map((parameter) =>
            readProperty(parameter, "name"),
          );
          expect(parameterNames).toContain("X-Request-Id");
        } else {
          const requestBody = readProperty(operation, "requestBody");
          const content = readProperty(requestBody, "content");
          const mediaType = readProperty(content, "application/json");
          const requestSchema = readProperty(mediaType, "schema");
          expect(schemaRequires(requestSchema, "request_id")).toBe(true);
          expect(schemaRequires(requestSchema, "idempotency_key")).toBe(true);
        }

        const responses = readProperty(operation, "responses");
        for (const response of Object.values(isRecord(responses) ? responses : {})) {
          const content = readProperty(response, "content");
          const jsonMediaType = readProperty(content, "application/json");
          if (jsonMediaType !== undefined) {
            const schema = readProperty(jsonMediaType, "schema");
            expect(schemaRequires(schema, "request_id")).toBe(true);
            expect(schemaRequires(schema, "trace_id")).toBe(true);
          } else {
            const headers = readProperty(response, "headers");
            expect(readProperty(headers, "X-Request-Id")).toBeDefined();
            expect(readProperty(headers, "X-Trace-Id")).toBeDefined();
          }
        }
      }
    }
  });

  it("uses explicit task and runtime status enums in response contracts", () => {
    const taskData = responseDataObject("TaskStatusResponse");
    const taskStatus = readProperty(readProperty(taskData, "properties"), "status");
    expect([...literalValues(taskStatus)].sort()).toEqual(Object.values(L2TaskStatus).sort());

    const adminData = responseDataObject("AdminActionResponse");
    const adminStatus = readProperty(readProperty(adminData, "properties"), "status");
    expect([...literalValues(adminStatus)].sort()).toEqual(Object.values(L1RuntimeStatus).sort());
  });

  it("uses the standard response envelope for health JSON", () => {
    const components = readProperty(openApiDocument, "components");
    const schemas = readProperty(components, "schemas");
    const health = readProperty(schemas, "HealthResponse");
    for (const field of ["success", "code", "message", "request_id", "trace_id", "data", "error"]) {
      expect(schemaRequires(health, field)).toBe(true);
    }
  });
});
