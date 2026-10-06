import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkloadObservations, MAX_LIFECYCLE_EVENTS, OBSERVATION_RETENTION_MS } from './observations.js';
import { UserContainerController } from './user-container-core.js';
const started = Date.parse('2026-10-05T12:00:00.000Z');
function fixture() {
  let now = started; const values = new Map();
  const storage = { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, async setAlarm() {}, async deleteAlarm() {} };
  const container = { running: false, images: { terminal: 'registry.test/base@sha256:fake' }, start(options) { this.running = true; this.options = options; },
    async setInactivityTimeout() {}, async exec() { return { output: async () => ({ exitCode: this.exitCode ?? 0 }) }; }, async destroy() { this.running = false; } };
  const controller = new UserContainerController({ storage, container }, () => now);
  const lifecycle = method => controller.fetch(new Request('https://internal/container', { method, headers: { 'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(now + 3600_000) } }));
  const events = (createdAt, extra = '') => controller.fetch(new Request('https://internal/observations/events' + extra, { headers: { 'x-exec-created-at': createdAt } }));
  return { values, container, controller, lifecycle, events, setTime(value) { now = value; } };
}

test('lifecycle readiness/stop history is durable, deduplicated and excludes private provider identity', async () => {
  const f = fixture();
  const result = await (await f.lifecycle('POST')).json(), generation = result.containers[0].createdAt;
  const initial = await (await f.events(generation, '?limit=1')).json();
  assert.deepEqual(initial.events.map(event => event.type), ['starting']); assert.equal(initial.hasMore, true);
  assert.equal(initial.events[0].sequence, 1); assert.ok(!('telemetryId' in initial.events[0])); assert.ok(!('expiresAt' in initial.events[0]));
  assert.match(f.container.options.labels.mb_generation, /^[a-f0-9-]{36}$/);
  const second = await (await f.events(generation, '?cursor=1')).json(); assert.deepEqual(second.events.map(event => event.type), ['started']);
  await f.lifecycle('DELETE'); await f.lifecycle('DELETE');
  const controller = new UserContainerController({ storage: f.controller.ctx.storage, container: f.container }, () => started);
  const persisted = await controller.observations.fetch(new Request('https://internal/observations/events', { headers: { 'x-exec-created-at': generation } }));
  const events = (await persisted.json()).events;
  assert.deepEqual(events.map(event => event.type), ['starting', 'started', 'stopped']);
  assert.equal(events.at(-1).reason, 'requested'); assert.equal(new Set(events.map(event => event.id)).size, 3);
  assert.equal((await f.events(generation, '?cursor=999')).status, 400);
  assert.equal((await f.events('2099-01-01T00:00:00.000Z')).status, 404);
});

test('failure events carry bounded categories and delayed platform observations cannot cross generations', async () => {
  const f = fixture(); f.container.exitCode = 7;
  assert.equal((await f.lifecycle('POST')).status, 500);
  const metadata = f.values.get('builderMachine'), generation = new Date(metadata.createdAt).toISOString();
  const events = (await (await f.events(generation)).json()).events;
  assert.deepEqual(events.map(event => event.type), ['starting', 'failed', 'stopped']);
  assert.equal(events[1].reason, 'startup_failed'); assert.ok(events.every(event => !JSON.stringify(event).includes('exit code')));
  f.container.exitCode = 0; f.setTime(started + 1); await f.lifecycle('POST');
  f.container.running = false;
  await f.controller.observePlatformStop(metadata.createdAt, true);
  assert.equal(f.values.get('builderMachine').computeStoppedAt, undefined);
  await f.controller.observePlatformStop(started + 1, true);
  await f.controller.observePlatformStop(started + 1, true);
  const latest = (await (await f.events(new Date(started + 1).toISOString())).json()).events;
  assert.deepEqual(latest.map(event => event.type), ['starting', 'started', 'failed', 'stopped']);
  assert.equal(latest.at(-1).reason, 'runtime_failed');
});

test('bounded journal prunes across generations, retains sequence fences and exposes missing history', async () => {
  const f = fixture(), observer = f.controller.observations;
  const first = { createdAt: started, telemetryId: crypto.randomUUID(), expiresAt: started + 1000 };
  await observer.append(first, 'starting');
  for (let n = 1; n < MAX_LIFECYCLE_EVENTS; n++) await observer.append({ ...first, createdAt: started + n }, 'starting');
  await observer.append(first, 'stopped', 'requested');
  assert.equal(f.values.get('workloadLifecycle').events.length, MAX_LIFECYCLE_EVENTS);
  const page = await (await f.events(new Date(started).toISOString())).json(); assert.equal(page.historyTruncated, true);
  assert.equal(page.events[0].sequence, MAX_LIFECYCLE_EVENTS + 1);
  assert.equal(await observer.nextCleanup(), started + OBSERVATION_RETENTION_MS);
  f.setTime(started + OBSERVATION_RETENTION_MS); await observer.prune();
  assert.equal(await observer.nextCleanup(), null);
  assert.equal((await f.events(new Date(started).toISOString())).status, 404);
  await observer.append({ ...first, createdAt: started + OBSERVATION_RETENTION_MS }, 'starting');
  assert.equal(f.values.get('workloadLifecycle').events[0].sequence, MAX_LIFECYCLE_EVENTS + 2);
});

test('natural stop observation does not renew a lease or execute inside the guest', async () => {
  const f = fixture(); const result = await (await f.lifecycle('POST')).json();
  let executions = 0; f.container.exec = async () => { executions++; throw new Error('unexpected'); };
  f.setTime(started + 5000); f.container.running = false;
  await f.lifecycle('GET');
  assert.equal(f.values.get('builderMachine').computeStoppedAt, started + 5000); assert.equal(executions, 0);
  const stopped = (await (await f.events(result.containers[0].createdAt)).json()).events.at(-1);
  assert.equal(stopped.type, 'stopped'); assert.equal(stopped.reason, 'runtime_stopped');
});
