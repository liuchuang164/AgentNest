import {
  deriveLogicalAgentId,
  intersectForTask,
  type TenantCapabilityCatalog,
} from "@agentnest/capability";
import type { TenantBizScope } from "@agentnest/contracts";
import type { ExecutionContextRecord, ExecutionContextRepository } from "@agentnest/persistence";

export interface CreateTaskExecutionContextInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface CreateTaskExecutionContextOptions {
  readonly now?: () => Date;
}

export class CreateTaskExecutionContext {
  readonly #now: () => Date;

  public constructor(
    private readonly catalog: TenantCapabilityCatalog,
    private readonly repository: ExecutionContextRepository,
    options: CreateTaskExecutionContextOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  public async execute(input: CreateTaskExecutionContextInput): Promise<ExecutionContextRecord> {
    const profile = await this.catalog.resolveProfile(input.scope);
    const authoritativeScope = {
      tenantId: profile.tenant_id,
      bizDomain: profile.biz_domain,
    };
    const expectedLogicalAgentId = deriveLogicalAgentId(authoritativeScope);
    if (input.logicalAgentId !== expectedLogicalAgentId) {
      throw new TypeError("logicalAgentId does not match the requested tenant/business scope");
    }
    const template = await this.catalog.resolveTaskTemplate(input.taskType);
    const effective = intersectForTask(profile, template);
    if (
      effective.skills.length === 0 ||
      Object.keys(effective.tools).length === 0 ||
      template.bizDomain !== authoritativeScope.bizDomain
    ) {
      throw new TypeError(
        "task template has no authorized capability for this tenant/business scope",
      );
    }
    const now = this.#now();
    if (Number.isNaN(now.getTime())) {
      throw new TypeError("clock returned an invalid Date");
    }
    const expiresAt = new Date(now.getTime() + profile.lifecycle.l2_idle_ttl_seconds * 1_000);
    return await this.repository.create({
      scope: authoritativeScope,
      logicalAgentId: expectedLogicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      allowedSkills: effective.skills,
      allowedTools: effective.tools,
      resourceScope: {
        resourceType: input.resourceType,
        resourceIds: [input.resourceId],
      },
      expiresAt,
      now,
    });
  }
}
