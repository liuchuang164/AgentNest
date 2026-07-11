BEGIN;

CREATE TABLE IF NOT EXISTS tenant_business (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, biz_domain),
  CHECK (tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  CHECK (biz_domain ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE TABLE IF NOT EXISTS tenant_capability_profile (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  profile_id text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  skills jsonb NOT NULL,
  tools jsonb NOT NULL,
  memory_scopes jsonb NOT NULL,
  lifecycle jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, biz_domain, profile_id),
  UNIQUE (tenant_id, biz_domain, version),
  FOREIGN KEY (tenant_id, biz_domain)
    REFERENCES tenant_business (tenant_id, biz_domain),
  CHECK (jsonb_typeof(skills) = 'array'),
  CHECK (jsonb_typeof(tools) = 'object'),
  CHECK (jsonb_typeof(memory_scopes) = 'array'),
  CHECK (jsonb_typeof(lifecycle) = 'object')
);

CREATE TABLE IF NOT EXISTS task_template (
  task_type text PRIMARY KEY,
  biz_domain text NOT NULL,
  skills jsonb NOT NULL,
  tools jsonb NOT NULL,
  memory_scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (biz_domain ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CHECK (jsonb_typeof(skills) = 'array'),
  CHECK (jsonb_typeof(tools) = 'object'),
  CHECK (jsonb_typeof(memory_scopes) = 'array')
);

CREATE TABLE IF NOT EXISTS tenant_biz_agent (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  logical_agent_id text NOT NULL,
  capability_profile_id text NOT NULL,
  status text NOT NULL,
  current_runtime_instance_id text,
  last_active_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, biz_domain, logical_agent_id),
  UNIQUE (logical_agent_id),
  UNIQUE (tenant_id, biz_domain),
  FOREIGN KEY (tenant_id, biz_domain)
    REFERENCES tenant_business (tenant_id, biz_domain),
  FOREIGN KEY (tenant_id, biz_domain, capability_profile_id)
    REFERENCES tenant_capability_profile (tenant_id, biz_domain, profile_id),
  CHECK (logical_agent_id ~ '^tb_[a-f0-9]{20}$'),
  CHECK (status IN (
    'PROVISIONING', 'ACTIVE', 'IDLE', 'CHECKPOINTING', 'CHECKPOINT_FAILED',
    'UNLOADING', 'UNLOAD_FAILED', 'UNLOADED', 'FAILED'
  ))
);

CREATE TABLE IF NOT EXISTS agent_runtime_instance (
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  openclaw_agent_id text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  last_active_at timestamptz NOT NULL,
  checkpointed_at timestamptz,
  unloaded_at timestamptz,
  restored_from_runtime_instance_id text,
  failure_reason text,
  PRIMARY KEY (logical_agent_id, runtime_instance_id),
  UNIQUE (runtime_instance_id),
  FOREIGN KEY (logical_agent_id) REFERENCES tenant_biz_agent (logical_agent_id),
  CHECK (status IN (
    'PROVISIONING', 'ACTIVE', 'IDLE', 'CHECKPOINTING', 'CHECKPOINT_FAILED',
    'UNLOADING', 'UNLOAD_FAILED', 'UNLOADED', 'FAILED'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_instance_one_active_idx
  ON agent_runtime_instance (logical_agent_id)
  WHERE status IN ('PROVISIONING', 'ACTIVE', 'IDLE');

CREATE INDEX IF NOT EXISTS tenant_capability_profile_scope_idx
  ON tenant_capability_profile (tenant_id, biz_domain, version DESC);

CREATE INDEX IF NOT EXISTS tenant_biz_agent_scope_status_idx
  ON tenant_biz_agent (tenant_id, biz_domain, status);

CREATE INDEX IF NOT EXISTS agent_runtime_instance_status_idx
  ON agent_runtime_instance (logical_agent_id, status, last_active_at);

COMMIT;
