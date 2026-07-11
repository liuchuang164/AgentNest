export interface TenantBizScope {
  readonly tenantId: string;
  readonly bizDomain: string;
}

export interface ScopedRepository<TRecord> {
  findById(scope: TenantBizScope, id: string): Promise<TRecord | null>;
}
