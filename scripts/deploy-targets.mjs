const backend = (worker, config, checks, preflight, publish) => ({
  directory: '.', worker, config, checks, preflight, publish,
});


// Each ordinary release has one worker. Coordinated backend operations have a
// separate workflow; security provisioning and SDK/image publishing stay explicit.
export const targets = {
  api: backend('mainbrella-api', 'wrangler.jsonc', ['test:api', 'test:openapi', 'type-check', 'check:api'], ['api:preflight'], 'deploy:api'),
  admin: backend('mainbrella-admin', 'wrangler.admin.jsonc', ['test:admin', 'type-check', 'check:admin'], ['admin:preflight'], 'deploy:admin'),
  marketing: backend('mainbrella-marketing', 'wrangler.marketing.jsonc', ['test:marketing', 'type-check', 'check:marketing'], ['marketing:preflight'], 'deploy:marketing'),
  containers: backend('mainbrella-containers', 'wrangler.containers.jsonc', ['test:containers', 'test:api', 'type-check', 'check:containers'], ['deploy:preflight'], 'deploy:containers'),
  previews: backend('mainbrella-previews', 'wrangler.previews.jsonc', ['test:api', 'type-check', 'check:previews'], ['previews:preflight'], 'deploy:previews'),

};

export function targetFor(name) {
  if (!Object.hasOwn(targets, name)) throw new Error(`Choose one deploy target: ${Object.keys(targets).join(', ')}.`);
  return targets[name];
}
