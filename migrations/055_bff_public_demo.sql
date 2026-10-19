-- Add own-row editing to the existing public example key only. Row policies
-- remain unchanged; login never changes a key grant or table policy.
UPDATE bff_api_key_grants
SET tables=json_set(tables, '$.messages',
  json_insert(json_extract(tables, '$.messages'), '$[#]', 'update'))
WHERE project_id='90da3093-84b6-4cd7-a39a-a8afc39403b8'
  AND api_key_id IN (
    SELECT k.id FROM api_keys k JOIN bff_projects p ON p.user_id=k.user_id
    WHERE p.id='90da3093-84b6-4cd7-a39a-a8afc39403b8'
      AND k.token_hash='e5906e35c913e2b79f96034830e20329940424ead22cc5302cee5d00f36851fb'
      AND k.prefix GLOB 'bff_pk_*'
  )
  AND json_type(tables, '$.messages')='array'
  AND EXISTS (SELECT 1 FROM json_each(tables, '$.messages') WHERE value='select')
  AND NOT EXISTS (SELECT 1 FROM json_each(tables, '$.messages') WHERE value='update');
