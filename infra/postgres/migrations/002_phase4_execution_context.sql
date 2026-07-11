BEGIN;

CREATE TABLE IF NOT EXISTS execution_context (
  execution_context_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_id text NOT NULL,
  allowed_skills jsonb NOT NULL,
  allowed_tools jsonb NOT NULL,
  resource_scope jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, biz_domain, execution_context_id),
  FOREIGN KEY (tenant_id, biz_domain, logical_agent_id)
    REFERENCES tenant_biz_agent (tenant_id, biz_domain, logical_agent_id),
  FOREIGN KEY (logical_agent_id, runtime_instance_id)
    REFERENCES agent_runtime_instance (logical_agent_id, runtime_instance_id),
  CHECK (jsonb_typeof(allowed_skills) = 'array'),
  CHECK (jsonb_typeof(allowed_tools) = 'object'),
  CHECK (jsonb_typeof(resource_scope) = 'object'),
  CHECK (jsonb_typeof(resource_scope -> 'resource_type') = 'string'),
  CHECK (jsonb_typeof(resource_scope -> 'resource_ids') = 'array'),
  CHECK (jsonb_array_length(resource_scope -> 'resource_ids') > 0),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS execution_context_scope_task_idx
  ON execution_context (tenant_id, biz_domain, task_id);

CREATE INDEX IF NOT EXISTS execution_context_expiry_idx
  ON execution_context (expires_at);

COMMIT;
