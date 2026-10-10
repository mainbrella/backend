-- Progress survives reconnects and Workflow replay, independently of the sandbox.
CREATE TABLE build_activity (
  turn_id TEXT NOT NULL REFERENCES build_turns(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('message', 'tool')),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed')),
  PRIMARY KEY(turn_id, id)
);
