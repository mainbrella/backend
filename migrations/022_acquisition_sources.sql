-- Record lifecycle facts in the same D1 transaction as the launch state.
-- Commands, logs, credentials and preview URLs never enter acquisition payloads.
CREATE TRIGGER acquisition_launch_insert AFTER INSERT ON repo_launches
WHEN json_valid(NEW.state_json)
BEGIN
  -- Persisted container state is written only after the coordinator reports running.
  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'workspace.started:' || NEW.user_id || ':' || json_extract(NEW.state_json, '$.container.id') || ':' || json_extract(NEW.state_json, '$.container.createdAt'),
    'workspace.started', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id),
    CAST(ROUND((julianday(json_extract(NEW.state_json, '$.container.createdAt')) - 2440587.5) * 86400000) AS INTEGER),
    CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    json_object('containerId', json_extract(NEW.state_json, '$.container.id'), 'createdAt', json_extract(NEW.state_json, '$.container.createdAt'))
  WHERE json_extract(NEW.state_json, '$.container.id') IS NOT NULL AND julianday(json_extract(NEW.state_json, '$.container.createdAt')) > 2440587.5
  ON CONFLICT(event_key) DO NOTHING;

  -- A clone alone does not activate a workload. Setup or HTTP readiness must succeed.
  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'workload.activated:' || NEW.id, 'workload.activated', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id),
    CASE WHEN json_extract(NEW.state_json, '$.previewReadyAt') > 0
      THEN json_extract(NEW.state_json, '$.previewReadyAt') ELSE CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) END,
    CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    json_object('launchId', NEW.id, 'repo', json_extract(NEW.state_json, '$.repository.repo'),
      'commit', json_extract(NEW.state_json, '$.repository.commit'),
      'basis', CASE WHEN json_extract(NEW.state_json, '$.previewReadyAt') > 0 THEN 'http_preview_ready'
        ELSE 'repository_setup_succeeded' END)
  WHERE json_extract(NEW.state_json, '$.phase') = 'ready'
    AND (json_extract(NEW.state_json, '$.previewReadyAt') > 0 OR
      (length(trim(json_extract(NEW.state_json, '$.options.setupCommand'))) > 0
        AND json_extract(NEW.state_json, '$.executions.setup') IS NOT NULL))
  ON CONFLICT(event_key) DO NOTHING;

  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'launch.failed:' || NEW.id, 'launch.failed', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id), CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER), CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    json_object('launchId', NEW.id, 'repo', json_extract(NEW.state_json, '$.repository.repo'),
      'failureStage', CASE json_extract(NEW.state_json, '$.error')
        WHEN 'allocation_reconciliation_required' THEN 'allocating'
        WHEN 'cloning_failed' THEN 'cloning'
        WHEN 'setup_failed' THEN 'setup'
        WHEN 'starting_failed' THEN 'starting'
        ELSE 'execution' END,
      'errorCode', CASE json_extract(NEW.state_json, '$.error')
        WHEN 'allocation_reconciliation_required' THEN 'allocation_reconciliation_required'
        WHEN 'cloning_failed' THEN 'cloning_failed'
        WHEN 'setup_failed' THEN 'setup_failed'
        WHEN 'starting_failed' THEN 'starting_failed'
        WHEN 'execution_reconciliation_required' THEN 'execution_reconciliation_required'
        WHEN 'execution_history_expired' THEN 'execution_history_expired'
        ELSE 'launch_failed' END)
  WHERE json_extract(NEW.state_json, '$.phase') = 'failed'
  ON CONFLICT(event_key) DO NOTHING;
END;

CREATE TRIGGER acquisition_launch_update AFTER UPDATE OF state_json ON repo_launches
WHEN json_valid(NEW.state_json)
BEGIN
  -- Persisted container state is written only after the coordinator reports running.
  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'workspace.started:' || NEW.user_id || ':' || json_extract(NEW.state_json, '$.container.id') || ':' || json_extract(NEW.state_json, '$.container.createdAt'),
    'workspace.started', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id),
    CAST(ROUND((julianday(json_extract(NEW.state_json, '$.container.createdAt')) - 2440587.5) * 86400000) AS INTEGER),
    CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    json_object('containerId', json_extract(NEW.state_json, '$.container.id'), 'createdAt', json_extract(NEW.state_json, '$.container.createdAt'))
  WHERE json_extract(NEW.state_json, '$.container.id') IS NOT NULL AND julianday(json_extract(NEW.state_json, '$.container.createdAt')) > 2440587.5
  ON CONFLICT(event_key) DO NOTHING;

  -- A clone alone does not activate a workload. Setup or HTTP readiness must succeed.
  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'workload.activated:' || NEW.id, 'workload.activated', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id),
    CASE WHEN json_extract(NEW.state_json, '$.previewReadyAt') > 0
      THEN json_extract(NEW.state_json, '$.previewReadyAt') ELSE CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER) END,
    CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    json_object('launchId', NEW.id, 'repo', json_extract(NEW.state_json, '$.repository.repo'),
      'commit', json_extract(NEW.state_json, '$.repository.commit'),
      'basis', CASE WHEN json_extract(NEW.state_json, '$.previewReadyAt') > 0 THEN 'http_preview_ready'
        ELSE 'repository_setup_succeeded' END)
  WHERE json_extract(NEW.state_json, '$.phase') = 'ready'
    AND (json_extract(NEW.state_json, '$.previewReadyAt') > 0 OR
      (length(trim(json_extract(NEW.state_json, '$.options.setupCommand'))) > 0
        AND json_extract(NEW.state_json, '$.executions.setup') IS NOT NULL))
  ON CONFLICT(event_key) DO NOTHING;

  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'launch.failed:' || NEW.id, 'launch.failed', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id), CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER), CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER),
    json_object('launchId', NEW.id, 'repo', json_extract(NEW.state_json, '$.repository.repo'),
      'failureStage', CASE json_extract(NEW.state_json, '$.error')
        WHEN 'allocation_reconciliation_required' THEN 'allocating'
        WHEN 'cloning_failed' THEN 'cloning'
        WHEN 'setup_failed' THEN 'setup'
        WHEN 'starting_failed' THEN 'starting'
        ELSE 'execution' END,
      'errorCode', CASE json_extract(NEW.state_json, '$.error')
        WHEN 'allocation_reconciliation_required' THEN 'allocation_reconciliation_required'
        WHEN 'cloning_failed' THEN 'cloning_failed'
        WHEN 'setup_failed' THEN 'setup_failed'
        WHEN 'starting_failed' THEN 'starting_failed'
        WHEN 'execution_reconciliation_required' THEN 'execution_reconciliation_required'
        WHEN 'execution_history_expired' THEN 'execution_history_expired'
        ELSE 'launch_failed' END)
  WHERE json_extract(NEW.state_json, '$.phase') = 'failed'
  ON CONFLICT(event_key) DO NOTHING;
END;

-- Version 1 qualification requires successful repository work on distinct UTC days.
CREATE TRIGGER acquisition_repeat_workload AFTER INSERT ON acquisition_events
WHEN NEW.event_type = 'workload.activated' AND NEW.user_id IS NOT NULL
BEGIN
  INSERT INTO acquisition_events(event_key, event_type, user_id, lead_id, occurred_at, recorded_at, payload)
  SELECT 'developer.qualified:' || NEW.user_id, 'developer.qualified', NEW.user_id,
    (SELECT lead_id FROM acquisition_accounts WHERE user_id = NEW.user_id),
    (SELECT MAX(occurred_at) FROM acquisition_events
      WHERE user_id = NEW.user_id AND event_type = 'workload.activated'), NEW.recorded_at,
    json_object('rule', 'two_repository_workloads_on_distinct_utc_days', 'version', 1)
  WHERE EXISTS (SELECT 1 FROM acquisition_events AS earlier
    WHERE earlier.user_id = NEW.user_id AND earlier.event_type = 'workload.activated'
      AND earlier.event_key != NEW.event_key
      AND earlier.occurred_at / 86400000 != NEW.occurred_at / 86400000)
  ON CONFLICT(event_key) DO NOTHING;
END;

