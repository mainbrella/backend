import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';
import { targetFor } from './staging-targets.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = new Set(['api', 'admin', 'marketing', 'containers', 'previews', 'site', 'builder', 'raindrop']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SOURCE_VARS = new Set([
  'VOICE_PUBLIC_ORIGIN', 'NAMECOM_MARKUP_BPS', 'R2_PLATFORM_MAX_BYTES',
  'R2_WRITES_PAUSED', 'R2_MARKUP_BPS', 'R2_ACCOUNT_MAX_BYTES', 'BUILD_MODEL',
  'ACTIVITY_WEBSOCKET_ENABLED', 'WORKSPACE_PERSISTENCE_ENABLED',
  'WORKSPACE_LIFECYCLE_ENABLED', 'SECURITY_FEATURE_ACCOUNTS', 'PREVIEW_DOMAIN',
  'GOOGLE_CLIENT_ID',
]);
const SOURCE_KEYS = new Set([
  '$schema', 'name', 'account_id', 'main', 'compatibility_date', 'compatibility_flags',
  'workers_dev', 'preview_urls', 'r2_buckets', 'cache', 'ai', 'version_metadata',
  'workflows', 'triggers', 'vars', 'send_email', 'services', 'd1_databases',
  'ratelimits', 'durable_objects', 'exports', 'observability', 'routes',
  'containers', 'assets', 'worker_loaders', 'browser', 'queues',
]);
const SOURCE_D1 = {
  api: ['DB', 'PREVIEW_ROUTES'], admin: ['DB'], marketing: ['DB'],
  previews: ['PREVIEW_ROUTES'],
};
const SOURCE_OBJECTS = {
  api: {
    RECEPTIONIST_CALL: [null, 'ReceptionistCall'],
    ACCOUNT_ACTIVITY: [null, 'AccountActivity'],
    CONTAINER_ACCOUNT: [null, 'ContainerAccount'],
    USER_CONTAINER: ['mainbrella-containers', 'UserContainer'],
  },
  admin: { CONTAINER_ACCOUNT: ['mainbrella-api', 'ContainerAccount'] },
  containers: {
    ACCOUNT_ACTIVITY: ['mainbrella-api', 'AccountActivity'],
    CONTAINER_ACCOUNT: ['mainbrella-api', 'ContainerAccount'],
  },
  previews: {
    USER_CONTAINER: ['mainbrella-containers', 'UserContainer'],
    CONTAINER_ACCOUNT: ['mainbrella-api', 'ContainerAccount'],
  },
};

function unsupported(target, detail) {
  throw new Error(`Unsupported staging source config for ${target}: ${detail}. Review its resource isolation before generating staging config.`);
}

function exactNames(target, label, actual, expected) {
  if (!isDeepStrictEqual([...actual].sort(), [...expected].sort())) unsupported(target, label);
}

function assertSupportedSourceConfig(target, configuration) {
  for (const key of Object.keys(configuration)) {
    if (!SOURCE_KEYS.has(key)) unsupported(target, `top-level ${key}`);
  }
  if (configuration.name !== targetFor(target).worker
    || configuration.account_id && configuration.account_id !== STAGING.accountId) {
    unsupported(target, 'worker name or account');
  }
  if (configuration.routes?.length && ['admin', 'marketing', 'containers'].includes(target)) {
    unsupported(target, 'private Worker routes');
  }
  const d1 = configuration.d1_databases ?? [];
  exactNames(target, 'D1 bindings', d1.map(item => item.binding), SOURCE_D1[target] ?? []);
  for (const item of d1) {
    if (!isDeepStrictEqual(Object.keys(item).sort(),
      (item.binding === 'DB' ? [
        'binding', 'database_name', 'database_id', 'migrations_table',
        ...(target === 'api' ? ['migrations_dir'] : []),
      ] : ['binding', 'database_name', 'database_id', 'migrations_dir']).sort())) {
      unsupported(target, `${item.binding} D1 fields`);
    }
  }
  const buckets = configuration.r2_buckets ?? [];
  exactNames(target, 'R2 bindings', buckets.map(item => item.binding), target === 'api' ? ['BUCKET'] : []);
  if (buckets.some(item => !isDeepStrictEqual(Object.keys(item).sort(), ['binding', 'bucket_name']))) {
    unsupported(target, 'R2 bucket fields');
  }
  const services = configuration.services ?? [];
  exactNames(target, 'service bindings', services.map(item => item.binding),
    target === 'api' ? ['ADMIN_API', 'MARKETING_API'] : []);
  for (const item of services) {
    const worker = item.binding === 'ADMIN_API' ? 'mainbrella-admin' : 'mainbrella-marketing';
    if (!isDeepStrictEqual(Object.keys(item).sort(), ['binding', 'service']) || item.service !== worker) {
      unsupported(target, `${item.binding} service reference`);
    }
  }
  if (configuration.durable_objects
    && !isDeepStrictEqual(Object.keys(configuration.durable_objects), ['bindings'])) {
    unsupported(target, 'Durable Object configuration fields');
  }
  const objects = configuration.durable_objects?.bindings ?? [];
  const expectedObjects = SOURCE_OBJECTS[target] ?? {};
  exactNames(target, 'Durable Object bindings', objects.map(item => item.name), Object.keys(expectedObjects));
  for (const item of objects) {
    const [worker, className] = expectedObjects[item.name];
    if (item.class_name !== className || (item.script_name ?? null) !== worker
      || !isDeepStrictEqual(Object.keys(item).sort(),
        (worker ? ['name', 'class_name', 'script_name'] : ['name', 'class_name']).sort())) {
      unsupported(target, `${item.name} Durable Object namespace or script reference`);
    }
  }
  const workflows = configuration.workflows ?? [];
  if (target === 'api') {
    if (!isDeepStrictEqual(configuration.browser, { binding: 'BROWSER' })
      || !isDeepStrictEqual(configuration.queues, {
        producers: [{ binding: 'BFF_PREVIEW_QUEUE', queue: 'mainbrella-bff-previews' }],
        consumers: [{ queue: 'mainbrella-bff-previews', max_batch_size: 1, max_batch_timeout: 1, max_retries: 2, max_concurrency: 2 }],
      })) unsupported(target, 'BFF browser or preview queue bindings');
  } else if (configuration.browser || configuration.queues) unsupported(target, 'BFF browser or preview queue bindings');
  const loaders = configuration.worker_loaders ?? [];
  if (!isDeepStrictEqual(loaders, target === 'api' ? [{ binding: 'BFF_LOADER' }] : [])) {
    unsupported(target, 'worker loader bindings');
  }
  exactNames(target, 'workflow bindings', workflows.map(item => item.binding), target === 'api' ? ['BUILD_WORKFLOW'] : []);
  if (workflows.some(item => item.name !== 'mainbrella-build' || item.class_name !== 'BuildWorkflow'
    || !isDeepStrictEqual(Object.keys(item).sort(), ['binding', 'name', 'class_name'].sort()))) {
    unsupported(target, 'workflow configuration');
  }
  const rates = configuration.ratelimits ?? [];
  exactNames(target, 'rate-limit bindings', rates.map(item => item.name),
    target === 'api' ? ['VOICE_NUMBER_SEARCH_LIMIT', 'EMAIL_AUTH_LIMIT', 'ACQUISITION_SUBMISSION_LIMIT'] : []);
  const rateIds = { VOICE_NUMBER_SEARCH_LIMIT: '1004', EMAIL_AUTH_LIMIT: '1002', ACQUISITION_SUBMISSION_LIMIT: '1003' };
  if (rates.some(item => item.namespace_id !== rateIds[item.name]
    || !isDeepStrictEqual(Object.keys(item).sort(), ['name', 'namespace_id', 'simple'].sort()))) {
    unsupported(target, 'rate-limit namespace');
  }
  const emails = configuration.send_email ?? [];
  exactNames(target, 'email bindings', emails.map(item => item.name),
    target === 'api' ? ['WELCOME_EMAIL'] : target === 'marketing' ? ['MARKETING_EMAIL'] : []);
  if (target === 'api') {
    if (!isDeepStrictEqual(configuration.ai, { binding: 'AI' })
      || !isDeepStrictEqual(configuration.cache, { enabled: true })
      || !isDeepStrictEqual(configuration.version_metadata, { binding: 'VERSION_METADATA' })) {
      unsupported(target, 'platform bindings');
    }
  } else if (configuration.ai || configuration.cache || configuration.version_metadata) {
    unsupported(target, 'platform bindings');
  }
  const expectedExports = target === 'api' ? ['ReceptionistCall', 'AccountActivity', 'ContainerAccount']
    : target === 'containers' ? ['UserContainer'] : [];
  exactNames(target, 'Durable Object exports', Object.keys(configuration.exports ?? {}), expectedExports);
  for (const item of Object.values(configuration.exports ?? {})) {
    if (!isDeepStrictEqual(item, { type: 'durable-object', storage: 'sqlite' })) {
      unsupported(target, 'Durable Object export fields');
    }
  }
  if (target === 'api' || target === 'previews') {
    if (!isDeepStrictEqual(configuration.triggers, { crons: ['*/5 * * * *'] })) {
      unsupported(target, 'scheduled triggers');
    }
  } else if (configuration.triggers) unsupported(target, 'scheduled triggers');
  if (['site', 'builder', 'raindrop'].includes(target)) {
    const directory = target === 'builder' ? './dist-builder' : './dist';
    if (!isDeepStrictEqual(configuration.assets, {
      directory, html_handling: 'auto-trailing-slash', not_found_handling: '404-page',
      ...(target === 'site' ? { binding: 'ASSETS', run_worker_first: ['/bff/demo/boards/*'] } : {}),
    })) unsupported(target, 'asset configuration');
  } else if (configuration.assets) unsupported(target, 'asset configuration');
  const containers = configuration.containers ?? [];
  if (target === 'containers') {
    if (containers.length !== 1 || containers[0].class_name !== 'UserContainer'
      || containers[0].scheduling_policy !== 'durable_object'
      || !isDeepStrictEqual(containers[0].images, { terminal: { dockerfile: './containers/Dockerfile' } })
      || Object.keys(containers[0]).some(key => !['class_name', 'scheduling_policy', 'images', 'ssh', 'authorized_keys'].includes(key))) {
      unsupported(target, 'container image or application fields');
    }
  } else if (containers.length) unsupported(target, 'container applications');
}

export const STAGING = Object.freeze({
  accountId: '2b7a9be82bb64187230703b024e25157',
  apiOrigin: 'https://api-stg.mainbrella.com',
  webOrigin: 'https://stg.mainbrella.com',
  adminOrigin: 'https://raindrop-stg.mainbrella.com',
  previewDomain: 'stg.mainbrella.dev',
  databaseName: 'delta-stg',
  previewDatabaseName: 'mainbrella-stg-preview-routes',
  bucketName: 'mainbrella-stg-storage',
});

function sourceConfig(target, directory) {
  if (!TARGETS.has(target)) throw new Error(`Unsupported staging target: ${target}`);
  const { directory: app, config } = targetFor(target);
  const configuration = JSON.parse(readFileSync(join(directory, app, config), 'utf8'));
  assertSupportedSourceConfig(target, configuration);
  return configuration;
}

export function assertStagingDatabaseId(databaseId, { directory = repoRoot } = {}) {
  if (!UUID.test(databaseId ?? '')) throw new Error('Staging needs a valid D1 database UUID from resource discovery.');
  const production = sourceConfig('api', directory);
  const productionIds = new Set(production.d1_databases.map(database => database.database_id.toLowerCase()));
  if (productionIds.has(databaseId.toLowerCase())) throw new Error('Staging cannot bind a production D1 database.');
  return databaseId;
}

function validatedResources(resources, directory) {
  const { databaseId, previewDatabaseId, bucketName = STAGING.bucketName } = resources ?? {};
  assertStagingDatabaseId(databaseId, { directory });
  assertStagingDatabaseId(previewDatabaseId, { directory });
  if (databaseId.toLowerCase() === previewDatabaseId.toLowerCase()) {
    throw new Error('Staging needs two distinct D1 database UUIDs from staging resource discovery.');
  }
  if (bucketName !== STAGING.bucketName) throw new Error('Staging R2 bucket must use its dedicated name.');
  return { databaseId, previewDatabaseId, bucketName };
}

function stageVars(configuration) {
  const vars = configuration.vars ?? {};
  for (const key of Object.keys(vars)) {
    if (!SAFE_SOURCE_VARS.has(key)) delete vars[key];
  }
  Object.assign(vars, {
    DEPLOYMENT_ENVIRONMENT: 'staging',
    R2_BILLING_MODE: 'off',
    NAMECOM_ENABLED: 'false',
    VOICE_ENABLED: 'false',
    BUILD_ENABLED: 'true',
    BFF_ENABLED: 'false',
    PREVIEWS_ENABLED: 'true',
    PROJECT_HOSTING_ENABLED: 'false',
    ACQUISITION_ENABLED: 'true',
    EGRESS_POLICIES_ENABLED: 'false',
    SECRETS_VAULT_ENABLED: 'false',
    SECURITY_FEATURE_ACCOUNTS: '',
    EMAIL_DELIVERY_ENABLED: 'false',
  });
  if ('VOICE_PUBLIC_ORIGIN' in vars) vars.VOICE_PUBLIC_ORIGIN = STAGING.apiOrigin;
  if ('PREVIEW_DOMAIN' in vars) vars.PREVIEW_DOMAIN = STAGING.previewDomain;
  configuration.vars = vars;
  delete configuration.send_email;
}

function stageDatabaseBindings(configuration, resources) {
  for (const database of configuration.d1_databases ?? []) {
    const preview = database.binding === 'PREVIEW_ROUTES';
    if (!preview && database.binding !== 'DB') throw new Error(`Unexpected D1 binding: ${database.binding}`);
    database.database_name = preview ? STAGING.previewDatabaseName : STAGING.databaseName;
    database.database_id = preview ? resources.previewDatabaseId : resources.databaseId;
  }
}

function stageWorkerReferences(configuration) {
  // BFF is disabled by default in staging; do not consume production jobs.
  delete configuration.queues;
  delete configuration.browser;
  for (const service of configuration.services ?? []) service.service += '-stg';
  for (const binding of configuration.durable_objects?.bindings ?? []) {
    if (binding.script_name) binding.script_name += '-stg';
  }
  for (const workflow of configuration.workflows ?? []) workflow.name += '-stg';
}

export function stagingConfig(target, { resources, directory = repoRoot, googleClientId } = {}) {
  const checked = validatedResources(resources, directory);
  const configuration = sourceConfig(target, directory);
  configuration.name += '-stg';
  configuration.account_id = STAGING.accountId;
  configuration.workers_dev = false;
  configuration.preview_urls = false;
  stageDatabaseBindings(configuration, checked);
  stageWorkerReferences(configuration);

  if (target === 'api') {
    configuration.r2_buckets.forEach(bucket => { bucket.bucket_name = checked.bucketName; });
    configuration.ratelimits.forEach(rate => { rate.namespace_id = String(Number(rate.namespace_id) + 10000); });
    stageVars(configuration);
    configuration.vars.PREVIEW_DOMAIN = STAGING.previewDomain;
    if (googleClientId !== undefined) configuration.vars.GOOGLE_CLIENT_ID = googleClientId;
    configuration.routes = [{ pattern: 'api-stg.mainbrella.com', custom_domain: true }];
  } else if (target === 'admin' || target === 'marketing' || target === 'containers' || target === 'previews') {
    stageVars(configuration);
    if (target === 'previews') {
      configuration.vars.PREVIEW_DOMAIN = STAGING.previewDomain;
      configuration.routes = [
        { pattern: 'stg.mainbrella.dev', custom_domain: true },
        // Production's *.mainbrella.dev route otherwise runs before this Custom Domain.
        { pattern: 'https://stg.mainbrella.dev/*', zone_id: 'e6597a41a75e1abb92f4bc5e5758c460' },
        { pattern: 'https://*.stg.mainbrella.dev/*', zone_id: 'e6597a41a75e1abb92f4bc5e5758c460' },
      ];
    } else if (target === 'containers') {
      for (const container of configuration.containers ?? []) {
        delete container.ssh;
        delete container.authorized_keys;
      }
    }
  } else {
    configuration.vars = { DEPLOYMENT_ENVIRONMENT: 'staging' };
    if (target === 'site') configuration.routes = [{ pattern: 'stg.mainbrella.com', custom_domain: true }];
    if (target === 'builder') configuration.routes = [{ pattern: 'stg.mainbrella.com/build/*', zone_name: 'mainbrella.com' }];
    if (target === 'raindrop') configuration.routes = [{ pattern: 'raindrop-stg.mainbrella.com', custom_domain: true }];
  }
  return configuration;
}

export function assertStagingConfig(target, configuration, options = {}) {
  if (!configuration || typeof configuration !== 'object') throw new Error('Staging config must be an object.');
  const expected = stagingConfig(target, options);
  const candidate = structuredClone(configuration);
  if (target === 'containers') {
    for (const [index, container] of (candidate.containers ?? []).entries()) {
      const expectedImages = expected.containers[index]?.images;
      if (!isDeepStrictEqual(container.images, expectedImages)) {
        const images = container.images;
        if (!images || typeof images !== 'object' || Array.isArray(images)
          || Object.keys(images).length !== IMAGE_CATALOG.length) {
          throw new Error('Staging container images must contain the complete maintained catalog.');
        }
        for (const entry of IMAGE_CATALOG) {
          const source = images[entry.key];
          const prefix = `registry.cloudflare.com/${STAGING.accountId}/${entry.repository}@sha256:`;
          if (!source || typeof source !== 'object' || Array.isArray(source)
            || Object.keys(source).length !== 1 || typeof source.image !== 'string'
            || !source.image.startsWith(prefix)
            || !/^[a-f0-9]{64}$/.test(source.image.slice(prefix.length))) {
            throw new Error(`Staging ${entry.key} image must use its maintained Cloudflare Registry digest.`);
          }
        }
        container.images = expectedImages;
      }
    }
  }
  if (!isDeepStrictEqual(candidate, expected)) {
    throw new Error(`Unsafe or unexpected ${target} staging configuration.`);
  }
  return configuration;
}
