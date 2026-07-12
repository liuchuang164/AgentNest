BEGIN;

INSERT INTO demo_resource (
  tenant_id, biz_domain, resource_type, resource_id, payload_json
)
VALUES
  (
    'tenant_A', 'LEGAL', 'CASE', 'case_001',
    '{"title":"Alpha contract evidence","facts":["alpha-signed-contract","alpha-payment-record"]}'::jsonb
  ),
  (
    'tenant_B', 'LEGAL', 'CASE', 'case_001',
    '{"title":"Beta delivery evidence","facts":["beta-delivery-note","beta-email-confirmation"]}'::jsonb
  ),
  (
    'tenant_B', 'LEGAL', 'CASE', 'case_B_only',
    '{"title":"Beta private case","facts":["beta-private-fact"]}'::jsonb
  ),
  (
    'tenant_A', 'ROBOT_DOG', 'DEVICE', 'device_001',
    '{"model":"AgentNest-Dog-1","firmware":"demo-1.0.0"}'::jsonb
  )
ON CONFLICT (tenant_id, biz_domain, resource_type, resource_id) DO UPDATE SET
  payload_json = EXCLUDED.payload_json,
  updated_at = now();

COMMIT;
