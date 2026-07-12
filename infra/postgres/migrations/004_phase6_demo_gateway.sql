BEGIN;

CREATE TABLE IF NOT EXISTS demo_resource (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, biz_domain, resource_type, resource_id),
  FOREIGN KEY (tenant_id, biz_domain)
    REFERENCES tenant_business (tenant_id, biz_domain),
  CHECK (resource_type IN ('CASE', 'DEVICE')),
  CHECK (length(resource_id) > 0),
  CHECK (jsonb_typeof(payload_json) = 'object')
);

CREATE TABLE IF NOT EXISTS demo_gateway_operation (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  operation_id uuid NOT NULL,
  gateway_name text NOT NULL,
  request_id text NOT NULL,
  trace_id text NOT NULL,
  execution_context_id uuid NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_id text NOT NULL,
  tool_name text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  params_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, biz_domain, operation_id),
  FOREIGN KEY (tenant_id, biz_domain, execution_context_id)
    REFERENCES execution_context (tenant_id, biz_domain, execution_context_id),
  FOREIGN KEY (tenant_id, biz_domain, task_id)
    REFERENCES agent_task (tenant_id, biz_domain, task_id),
  FOREIGN KEY (tenant_id, biz_domain, resource_type, resource_id)
    REFERENCES demo_resource (tenant_id, biz_domain, resource_type, resource_id),
  CHECK (gateway_name IN ('DATA', 'EXTERNAL')),
  CHECK (length(request_id) > 0),
  CHECK (length(trace_id) > 0),
  CHECK (length(tool_name) > 0),
  CHECK (length(action) > 0),
  CHECK (jsonb_typeof(params_json) = 'object'),
  CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE TABLE IF NOT EXISTS gateway_trace_event (
  gateway_trace_event_id uuid PRIMARY KEY,
  gateway_name text NOT NULL,
  request_id text NOT NULL,
  trace_id text NOT NULL,
  execution_context_id uuid,
  tenant_id text,
  biz_domain text,
  logical_agent_id text,
  runtime_instance_id text,
  session_id text,
  task_id text,
  tool_name text,
  action text,
  resource_type text,
  resource_id text,
  decision text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (gateway_name IN ('DATA', 'EXTERNAL')),
  CHECK (decision IN ('ALLOW', 'DENY')),
  CHECK (length(request_id) > 0),
  CHECK (length(trace_id) > 0),
  CHECK (length(reason) > 0),
  CHECK (
    (tenant_id IS NULL AND biz_domain IS NULL AND logical_agent_id IS NULL
      AND runtime_instance_id IS NULL AND session_id IS NULL AND task_id IS NULL)
    OR
    (tenant_id IS NOT NULL AND biz_domain IS NOT NULL AND logical_agent_id IS NOT NULL
      AND runtime_instance_id IS NOT NULL AND session_id IS NOT NULL AND task_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS demo_gateway_operation_scope_task_idx
  ON demo_gateway_operation (
    tenant_id, biz_domain, task_id, tool_name, action, created_at DESC
  );

CREATE INDEX IF NOT EXISTS demo_gateway_operation_scope_resource_idx
  ON demo_gateway_operation (
    tenant_id, biz_domain, resource_type, resource_id, created_at DESC
  );

CREATE INDEX IF NOT EXISTS gateway_trace_event_scope_trace_idx
  ON gateway_trace_event (tenant_id, biz_domain, trace_id, created_at DESC);

COMMIT;
