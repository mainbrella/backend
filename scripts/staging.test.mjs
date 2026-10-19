import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments, runStaging, stagingPlan } from './staging.mjs';

const sourceSha = 'a'.repeat(40);

test('staging CLI parses only the supported commands and targets', () => {
  assert.deepEqual(parseArguments(['plan']), { command: 'plan' });
  assert.deepEqual(parseArguments(['check']), { command: 'check', target: 'all' });
  assert.deepEqual(parseArguments(['check', 'api']), { command: 'check', target: 'api' });
  assert.deepEqual(parseArguments(['check', 'all']), { command: 'check', target: 'all' });
  assert.deepEqual(parseArguments(['provision']), { command: 'provision', apply: false });
  assert.deepEqual(parseArguments(['provision', '--apply']), { command: 'provision', apply: true });
  assert.deepEqual(parseArguments(['deploy', 'site']), { command: 'deploy', target: 'site' });
  for (const command of ['bootstrap', 'migrate-api', 'migrate-previews']) {
    assert.deepEqual(parseArguments([command]), { command, target: 'all' });
  }
  for (const args of [[], ['deploy'], ['deploy', 'all'], ['deploy', 'unknown'], ['check', 'unknown'],
    ['provision', '--force'], ['plan', 'api'], ['bootstrap', 'site'], ['migrate-api', '--apply']]) {
    assert.throws(() => parseArguments(args), /Usage: node scripts\/staging\.mjs/);
  }
});

test('plan prints the three staging hosts and dedicated resource names without invoking I/O', async () => {
  const output = [];
  await runStaging(['plan'], {
    log: line => output.push(line),
    run: () => { throw new Error('plan must not invoke commands'); },
    request: () => { throw new Error('plan must not make HTTP requests'); },
    provision: () => { throw new Error('plan must not provision resources'); },
  });
  assert.deepEqual(JSON.parse(output[0]), stagingPlan());
  assert.deepEqual(Object.values(stagingPlan().hosts), [
    'https://stg.mainbrella.com', 'https://api-stg.mainbrella.com', 'https://raindrop-stg.mainbrella.com',
  ]);
  assert.deepEqual(Object.values(stagingPlan().resources), [
    'delta-stg', 'mainbrella-stg-preview-routes', 'mainbrella-stg-storage',
  ]);
});

test('check delegates to the offline staging operation with all as its default target', async () => {
  const output = [];
  let received;
  const result = await runStaging(['check'], {
    directory: '/fixture', env: { SAFE: 'yes' },
    run: () => { throw new Error('check test should not provision or dispatch'); },
    request: () => { throw new Error('check test should not make an HTTP request'); },
    operation: async (name, options) => { received = { name, options }; return { checked: true }; },
    log: line => output.push(line),
  });
  assert.equal(result.checked, true);
  assert.equal(received.name, 'check');
  assert.equal(received.options.target, 'all');
  assert.equal(received.options.directory, '/fixture');
  assert.deepEqual(received.options.env, { SAFE: 'yes' });
  assert.equal(typeof received.options.run, 'function');
  assert.equal(typeof received.options.request, 'function');
  assert.equal(JSON.parse(output[0]).checked, true);
});

test('check accepts an explicit target', async () => {
  let selected;
  await runStaging(['check', 'previews'], {
    operation: async (_name, { target }) => { selected = target; }, log: () => {},
  });
  assert.equal(selected, 'previews');
});

test('provision plans by default and only creates resources with --apply', async () => {
  let calls = 0;
  const output = [];
  const provision = async options => { calls++; assert.equal(options.create, true); return { databaseId: 'd1-id', previewDatabaseId: 'preview-id', bucketName: 'stage-bucket' }; };
  await runStaging(['provision'], { provision, log: line => output.push(line) });
  assert.equal(calls, 0);
  assert.match(output[0], /provision --apply/);
  const result = await runStaging(['provision', '--apply'], { provision, log: line => output.push(line) });
  assert.equal(calls, 1);
  assert.deepEqual(result, { databaseId: 'd1-id', previewDatabaseId: 'preview-id', bucketName: 'stage-bucket' });
  assert.deepEqual(JSON.parse(output[1]).resources, result);
});

test('local staging dispatch requires a clean commit on a pushed backend repository origin branch', async () => {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'git' && args[0] === 'status') return '';
    if (command === 'git' && args[0] === 'rev-parse') return sourceSha;
    if (command === 'git' && args[0] === 'branch') return 'feature/staging';
    if (command === 'git' && args[0] === 'remote') return 'git@github.com:mainbrella/backend.git';
    return '';
  };
  const output = [];
  await runStaging(['deploy', 'api'], { run, directory: '/repo', log: line => output.push(line) });
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['git', ['status', '--porcelain']],
    ['git', ['rev-parse', 'HEAD']],
    ['git', ['branch', '--show-current']],
    ['git', ['check-ref-format', '--branch', 'feature/staging']],
    ['git', ['remote', 'get-url', 'origin']],
    ['git', ['fetch', '--no-tags', 'origin', 'feature/staging']],
    ['git', ['merge-base', '--is-ancestor', sourceSha, 'FETCH_HEAD']],
    ['gh', ['workflow', 'run', 'staging.yml', '--repo', 'mainbrella/backend', '--ref', 'main',
      '-f', 'operation=deploy', '-f', 'target=api', `-f`, `source_sha=${sourceSha}`, '-f', 'source_branch=feature/staging']],
  ]);
  assert.ok(calls.every(call => call.options.cwd === '/repo'));
  assert.match(output[0], /staging deploy for api/);
});

test('dirty, detached, non-backend repository, and unpushed sources stop dispatch before GitHub', async () => {
  const cases = [
    { status: ' M apps/web/index.html', expected: /Commit the intended staging source/ },
    { branch: '', expected: /named branch/ },
    { remote: 'git@github.com:fork/canopy.git', expected: /Origin must be mainbrella\/backend/ },
    { failure: 'git merge-base --is-ancestor', expected: /unpushed source/ },
  ];
  for (const scenario of cases) {
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      if (command === 'git' && args[0] === 'status') return scenario.status ?? '';
      if (command === 'git' && args[0] === 'rev-parse') return sourceSha;
      if (command === 'git' && args[0] === 'branch') return scenario.branch ?? 'main';
      if (command === 'git' && args[0] === 'remote') return scenario.remote ?? 'https://github.com/mainbrella/backend.git';
      if (scenario.failure && `${command} ${args.join(' ')}`.startsWith(scenario.failure)) throw new Error('unpushed source');
      return '';
    };
    await assert.rejects(runStaging(['bootstrap'], { run, log: () => {} }), scenario.expected);
    assert.equal(calls.some(({ command }) => command === 'gh'), false);
  }
});

test('workflow is main-owned, gated, serialized, and limited to staging credentials', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/staging.yml', import.meta.url), 'utf8');
  assert.match(workflow, /options: \[bootstrap, deploy, migrate-api, migrate-previews\]/);
  assert.match(workflow, /options: \[all, api, admin, marketing, containers, previews, site, builder, raindrop\]/);
  assert.match(workflow, /group: canopy-staging\s+cancel-in-progress: false/);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /STAGING_DEPLOYS_ENABLED/);
  assert.match(workflow, /VITE_API_URL: https:\/\/api-stg\.mainbrella\.com/);
  assert.match(workflow, /VITE_GA_MEASUREMENT_ID: ''/);
  assert.match(workflow, /GITHUB_WORKFLOW_REF.*staging\.yml@refs\/heads\/main/);
  assert.match(workflow, /node scripts\/staging-release\.mjs "\$OPERATION" "\$RELEASE_TARGET"/);
  assert.match(workflow, /artifacts\/staging\//);
  assert.doesNotMatch(workflow, /IMAGE_BUILD_SECRET|PRODUCTION_DEPLOYS_ENABLED|secrets\.CLOUDFLARE_API_TOKEN.*deploy\.yml/);
});
