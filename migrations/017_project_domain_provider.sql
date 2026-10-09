ALTER TABLE project_domains
ADD COLUMN provider TEXT CHECK(provider IS NULL OR provider IN ('cloudflare', 'ingress'));
