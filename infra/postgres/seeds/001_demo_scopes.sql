BEGIN;

INSERT INTO tenant_business (tenant_id, biz_domain)
VALUES
  ('tenant_A', 'LEGAL'),
  ('tenant_A', 'ROBOT_DOG'),
  ('tenant_B', 'LEGAL')
ON CONFLICT (tenant_id, biz_domain) DO UPDATE SET enabled = true, updated_at = now();

INSERT INTO tenant_capability_profile (
  tenant_id, biz_domain, profile_id, version, skills, tools, memory_scopes, lifecycle
)
VALUES
  (
    'tenant_A', 'LEGAL', 'cap_tenant_a_legal_v1', 1,
    '["legal-evidence-check"]'::jsonb,
    '{"legal_case_read":["read"],"legal_analysis_write":["write"],"legal_research_query":["query"]}'::jsonb,
    '["TENANT_BIZ_MEMORY","RESOURCE_MEMORY"]'::jsonb,
    '{"l1_idle_ttl_seconds":86400,"l2_idle_ttl_seconds":3600,"max_active_l2":5}'::jsonb
  ),
  (
    'tenant_A', 'ROBOT_DOG', 'cap_tenant_a_robot_dog_v1', 1,
    '["robot-dog-health-check"]'::jsonb,
    '{"robot_device_read":["read"],"robot_health_write":["write"],"robot_telemetry_enrich":["query"]}'::jsonb,
    '["TENANT_BIZ_MEMORY","RESOURCE_MEMORY"]'::jsonb,
    '{"l1_idle_ttl_seconds":86400,"l2_idle_ttl_seconds":3600,"max_active_l2":5}'::jsonb
  ),
  (
    'tenant_B', 'LEGAL', 'cap_tenant_b_legal_v1', 1,
    '["legal-evidence-check"]'::jsonb,
    '{"legal_case_read":["read"],"legal_analysis_write":["write"],"legal_research_query":["query"]}'::jsonb,
    '["TENANT_BIZ_MEMORY","RESOURCE_MEMORY"]'::jsonb,
    '{"l1_idle_ttl_seconds":86400,"l2_idle_ttl_seconds":3600,"max_active_l2":5}'::jsonb
  )
ON CONFLICT (tenant_id, biz_domain, profile_id) DO UPDATE SET
  skills = EXCLUDED.skills,
  tools = EXCLUDED.tools,
  memory_scopes = EXCLUDED.memory_scopes,
  lifecycle = EXCLUDED.lifecycle;

INSERT INTO task_template (task_type, biz_domain, skills, tools, memory_scopes)
VALUES
  (
    'LEGAL_EVIDENCE_CHECK', 'LEGAL',
    '["legal-evidence-check"]'::jsonb,
    '{"legal_case_read":["read"],"legal_analysis_write":["write"],"legal_research_query":["query"]}'::jsonb,
    '["TENANT_BIZ_MEMORY","RESOURCE_MEMORY"]'::jsonb
  ),
  (
    'ROBOT_DOG_HEALTH_CHECK', 'ROBOT_DOG',
    '["robot-dog-health-check"]'::jsonb,
    '{"robot_device_read":["read"],"robot_health_write":["write"],"robot_telemetry_enrich":["query"]}'::jsonb,
    '["TENANT_BIZ_MEMORY","RESOURCE_MEMORY"]'::jsonb
  )
ON CONFLICT (task_type) DO UPDATE SET
  biz_domain = EXCLUDED.biz_domain,
  skills = EXCLUDED.skills,
  tools = EXCLUDED.tools,
  memory_scopes = EXCLUDED.memory_scopes;

COMMIT;
