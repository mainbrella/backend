const backend = (worker, config, checks, preflight, publish) => ({
  directory: '.', worker, config, checks, preflight, publish,
});
const web = (worker, config, checks, publish, assets) => ({
  directory: '../web', worker, config, checks, preflight: [], publish, assets,
});

// Each ordinary release has one worker. Coordinated backend operations have a
// separate workflow; security provisioning and SDK/image publishing stay explicit.
export const targets = {
  api: backend('mainbrella-api', 'wrangler.jsonc', ['test:api', 'test:openapi', 'type-check', 'check:api'], ['api:preflight'], 'deploy:api'),
  admin: backend('mainbrella-admin', 'wrangler.admin.jsonc', ['test:admin', 'type-check', 'check:admin'], ['admin:preflight'], 'deploy:admin'),
  marketing: backend('mainbrella-marketing', 'wrangler.marketing.jsonc', ['test:marketing', 'type-check', 'check:marketing'], ['marketing:preflight'], 'deploy:marketing'),
  containers: backend('mainbrella-containers', 'wrangler.containers.jsonc', ['test:containers', 'test:api', 'type-check', 'check:containers'], ['deploy:preflight'], 'deploy:containers'),
  previews: backend('mainbrella-previews', 'wrangler.previews.jsonc', ['test:api', 'type-check', 'check:previews'], ['previews:preflight'], 'deploy:previews'),
  site: web('mainbrella-web', 'wrangler.jsonc', ['docs:check', 'test', 'build:site'], 'deploy:site', './dist'),
  builder: web('mainbrella-builder', 'wrangler.builder.jsonc', ['test', 'build:builder'], 'deploy:builder', './dist-builder'),
  redirect: web('mainbrella-www-redirect', 'wrangler.redirect.jsonc', ['test'], 'deploy:redirect'),
  raindrop: {
    directory: '../raindrop', worker: 'mainbrella-raindrop',
    config: 'wrangler.jsonc', checks: ['build', 'check:routes'], preflight: [], publish: 'deploy', assets: './dist',
  },
};

export function targetFor(name) {
  if (!Object.hasOwn(targets, name)) throw new Error(`Choose one deploy target: ${Object.keys(targets).join(', ')}.`);
  return targets[name];
}
