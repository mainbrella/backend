-- One durable record per logical operation/attempt. A start is local intent;
-- unknown remains unknown until a definitive outcome is retained.
CREATE TABLE build_operations (
  turn_id TEXT NOT NULL REFERENCES build_turns(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL DEFAULT '1',
  schema_version INTEGER NOT NULL,
  deployment_version TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('text','image','tool','command','source','billing','cleanup')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','skipped','blocked','succeeded','failed','unknown')),
  dispatch_attempted INTEGER CHECK(dispatch_attempted IN (0,1)),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  source_json TEXT CHECK(source_json IS NULL OR json_valid(source_json)),
  PRIMARY KEY(turn_id, operation_id, attempt_id)
);
CREATE INDEX build_operations_timeline ON build_operations(turn_id, created_at);
ALTER TABLE build_turns ADD COLUMN failure_operation_id TEXT;

-- Proposed and uncertain activities must not be presented as known failures.
ALTER TABLE build_activity RENAME TO build_activity_previous;
CREATE TABLE build_activity (
  turn_id TEXT NOT NULL REFERENCES build_turns(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('message','tool')),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','running','skipped','blocked','succeeded','failed','unknown')),
  PRIMARY KEY(turn_id, id)
);
INSERT INTO build_activity SELECT * FROM build_activity_previous;
DROP TABLE build_activity_previous;
