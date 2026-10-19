-- Keep existing scoped tokens valid while moving their lifecycle to /api-keys.
INSERT INTO api_keys(id,user_id,name,token_hash,prefix,created_at)
  SELECT k.id,p.user_id,k.name,k.token_hash,k.prefix,k.created_at
  FROM bff_api_keys k JOIN bff_projects p ON p.id=k.project_id;

CREATE TABLE bff_api_key_grants (
  api_key_id TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES bff_projects(id) ON DELETE CASCADE,
  origins TEXT NOT NULL CHECK(json_valid(origins)),
  tables TEXT NOT NULL CHECK(json_valid(tables)),
  functions TEXT NOT NULL CHECK(json_valid(functions))
);
CREATE INDEX bff_api_key_grants_project ON bff_api_key_grants(project_id);
INSERT INTO bff_api_key_grants(api_key_id,project_id,origins,tables,functions)
  SELECT id,project_id,origins,tables,functions FROM bff_api_keys;
DROP TABLE bff_api_keys;

-- Project deletion and project-level revocation also remove the shared key.
CREATE TRIGGER bff_api_key_grant_deleted AFTER DELETE ON bff_api_key_grants
BEGIN
  DELETE FROM api_keys WHERE id=OLD.api_key_id;
END;
