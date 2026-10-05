CREATE TABLE status_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  component TEXT NOT NULL CHECK (component IN ('website','api','auth','provisioning','ssh','images','billing')),
  state TEXT NOT NULL CHECK (state IN ('operational','degraded','outage','unknown')),
  scope TEXT NOT NULL CHECK (scope IN ('reachability','control_plane','synthetic')),
  latency_ms INTEGER CHECK (latency_ms >= 0),
  checked_at TEXT NOT NULL
);
CREATE INDEX status_observations_component_time ON status_observations(component, checked_at DESC, id DESC);
CREATE INDEX status_observations_time ON status_observations(checked_at DESC, id DESC);

CREATE TABLE status_incidents (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL CHECK (component IN ('website','api','auth','provisioning','ssh','images','billing')),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('investigating','identified','monitoring','resolved')),
  message TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
