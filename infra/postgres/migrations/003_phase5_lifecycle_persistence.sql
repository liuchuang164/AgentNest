BEGIN;

CREATE TABLE IF NOT EXISTS agent_task (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  task_id text NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_type text NOT NULL,
  status text NOT NULL,
  current_step text,
  input_json jsonb NOT NULL,
  result_json jsonb,
  last_active_at timestamptz NOT NULL,
  checkpointed_at timestamptz,
  unloaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, biz_domain, task_id),
  FOREIGN KEY (tenant_id, biz_domain, logical_agent_id)
    REFERENCES tenant_biz_agent (tenant_id, biz_domain, logical_agent_id),
  FOREIGN KEY (logical_agent_id, runtime_instance_id)
    REFERENCES agent_runtime_instance (logical_agent_id, runtime_instance_id),
  CHECK (status IN (
    'QUEUED', 'SPAWNING', 'RUNNING', 'WAITING_INPUT', 'COMPLETED', 'FAILED',
    'CHECKPOINTED', 'UNLOADED'
  )),
  CHECK (jsonb_typeof(input_json) = 'object'),
  CHECK (result_json IS NULL OR jsonb_typeof(result_json) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_session_summary (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  summary_id uuid NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_id text NOT NULL,
  summary text NOT NULL,
  transcript_path text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, biz_domain, summary_id),
  UNIQUE (tenant_id, biz_domain, logical_agent_id, session_id, task_id),
  FOREIGN KEY (tenant_id, biz_domain, task_id)
    REFERENCES agent_task (tenant_id, biz_domain, task_id),
  CHECK (length(summary) > 0),
  CHECK (length(transcript_path) > 0),
  CHECK (transcript_path !~ '(^/|(^|/)\.\.(/|$))')
);

CREATE TABLE IF NOT EXISTS agent_memory (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  memory_id uuid NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_id text NOT NULL,
  dedupe_key text NOT NULL,
  memory_type text NOT NULL,
  resource_type text,
  resource_id text,
  content text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, biz_domain, memory_id),
  UNIQUE (tenant_id, biz_domain, logical_agent_id, task_id, dedupe_key),
  FOREIGN KEY (tenant_id, biz_domain, task_id)
    REFERENCES agent_task (tenant_id, biz_domain, task_id),
  CHECK (length(dedupe_key) > 0),
  CHECK (length(memory_type) > 0),
  CHECK (length(content) > 0),
  CHECK ((resource_type IS NULL) = (resource_id IS NULL))
);

CREATE TABLE IF NOT EXISTS agent_trace (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  trace_event_id uuid NOT NULL,
  trace_id text NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_id text NOT NULL,
  event_key text NOT NULL,
  event_type text NOT NULL,
  decision text,
  reason text,
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, biz_domain, trace_event_id),
  UNIQUE (tenant_id, biz_domain, task_id, event_key),
  FOREIGN KEY (tenant_id, biz_domain, task_id)
    REFERENCES agent_task (tenant_id, biz_domain, task_id),
  CHECK (length(trace_id) > 0),
  CHECK (length(event_key) > 0),
  CHECK (length(event_type) > 0),
  CHECK (decision IS NULL OR decision IN ('ALLOW', 'DENY')),
  CHECK (jsonb_typeof(event_json) = 'object')
);

CREATE TABLE IF NOT EXISTS agent_checkpoint_artifact (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  checkpoint_id uuid NOT NULL,
  checkpoint_level text NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text,
  task_id text,
  snapshot_path text NOT NULL,
  transcript_path text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, biz_domain, checkpoint_id),
  UNIQUE NULLS NOT DISTINCT (
    tenant_id, biz_domain, logical_agent_id, runtime_instance_id, session_id, task_id,
    checkpoint_level
  ),
  FOREIGN KEY (tenant_id, biz_domain, task_id)
    REFERENCES agent_task (tenant_id, biz_domain, task_id),
  CHECK (checkpoint_level IN ('L1', 'L2')),
  CHECK (
    (checkpoint_level = 'L1' AND session_id IS NULL AND task_id IS NULL)
    OR
    (checkpoint_level = 'L2' AND session_id IS NOT NULL AND task_id IS NOT NULL)
  ),
  CHECK (length(snapshot_path) > 0),
  CHECK (length(transcript_path) > 0),
  CHECK (snapshot_path !~ '(^/|(^|/)\.\.(/|$))'),
  CHECK (transcript_path !~ '(^/|(^|/)\.\.(/|$))')
);

CREATE TABLE IF NOT EXISTS demo_tool_completion_marker (
  tenant_id text NOT NULL,
  biz_domain text NOT NULL,
  marker_id uuid NOT NULL,
  logical_agent_id text NOT NULL,
  runtime_instance_id text NOT NULL,
  session_id text NOT NULL,
  task_id text NOT NULL,
  tool_name text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  result_json jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, biz_domain, marker_id),
  UNIQUE (
    tenant_id, biz_domain, task_id, tool_name, action, resource_type, resource_id
  ),
  FOREIGN KEY (tenant_id, biz_domain, task_id)
    REFERENCES agent_task (tenant_id, biz_domain, task_id),
  CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE INDEX IF NOT EXISTS agent_task_scope_status_activity_idx
  ON agent_task (tenant_id, biz_domain, logical_agent_id, status, last_active_at);

CREATE INDEX IF NOT EXISTS agent_session_summary_scope_created_idx
  ON agent_session_summary (tenant_id, biz_domain, logical_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_memory_scope_created_idx
  ON agent_memory (tenant_id, biz_domain, logical_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_trace_scope_created_idx
  ON agent_trace (tenant_id, biz_domain, logical_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_checkpoint_scope_created_idx
  ON agent_checkpoint_artifact (
    tenant_id, biz_domain, logical_agent_id, checkpoint_level, created_at DESC
  );

COMMIT;
