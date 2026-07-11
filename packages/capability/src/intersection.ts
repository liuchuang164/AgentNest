import type { CapabilityProfile } from "@agentnest/contracts";

import { CapabilityEscalationError } from "./errors.js";
import type { EffectiveTaskCapability, TaskTemplate, ToolActions } from "./types.js";

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function intersection(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return uniqueSorted(left.filter((value) => rightSet.has(value)));
}

function intersectTools(parent: ToolActions, requested: ToolActions): ToolActions {
  const result: Record<string, readonly string[]> = {};
  for (const toolName of Object.keys(requested).sort()) {
    const parentActions = parent[toolName];
    const requestedActions = requested[toolName];
    if (parentActions === undefined || requestedActions === undefined) {
      continue;
    }
    const actions = intersection(parentActions, requestedActions);
    if (actions.length > 0) {
      result[toolName] = actions;
    }
  }
  return result;
}

export function intersectForTask(
  parent: CapabilityProfile,
  template: TaskTemplate,
): EffectiveTaskCapability {
  if (parent.biz_domain !== template.bizDomain) {
    return { skills: [], tools: {}, memoryScopes: [] };
  }
  return {
    skills: intersection(parent.skills, template.skills),
    tools: intersectTools(parent.tools, template.tools),
    memoryScopes: intersection(parent.memory_scopes, template.memoryScopes),
  };
}

export function assertSubset(
  child: EffectiveTaskCapability,
  parent: Pick<CapabilityProfile, "skills" | "tools" | "memory_scopes">,
): void {
  const parentSkills = new Set(parent.skills);
  for (const skill of child.skills) {
    if (!parentSkills.has(skill)) {
      throw new CapabilityEscalationError("skill", skill);
    }
  }

  for (const [toolName, actions] of Object.entries(child.tools)) {
    const parentActions = parent.tools[toolName];
    if (parentActions === undefined) {
      throw new CapabilityEscalationError("tool", toolName);
    }
    const allowedActions = new Set(parentActions);
    for (const action of actions) {
      if (!allowedActions.has(action)) {
        throw new CapabilityEscalationError("action", `${toolName}/${action}`);
      }
    }
  }

  const parentMemory = new Set(parent.memory_scopes);
  for (const scope of child.memoryScopes) {
    if (!parentMemory.has(scope)) {
      throw new CapabilityEscalationError("memory", scope);
    }
  }
}

export function assertRequestedCapabilityAllowed(
  requested: EffectiveTaskCapability,
  parent: Pick<CapabilityProfile, "skills" | "tools" | "memory_scopes">,
): void {
  assertSubset(requested, parent);
}
