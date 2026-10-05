import test from "node:test";
import assert from "node:assert/strict";
import { UserContainerController } from "./user-container-core.js";

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(at) { this.alarmAt = at; }
  async deleteAlarm() { this.alarmAt = null; }
}

class FakeContainer {
  images = { terminal: "registry.test/mainbrella-terminal@sha256:fake" };
  running = false;
  starts = 0;
  destroys = 0;
  inactivityTimeouts = [];
  startOptions = [];
  exitCode = 0;
  readyGate = null;
  readinessHangs = false;
  destroyError = null;
  async start(options) {
    this.starts += 1;
    this.startOptions.push(options);
    this.running = true;
  }
  async setInactivityTimeout(timeout) { this.inactivityTimeouts.push(timeout); }
  async exec(argv) {
    assert.deepEqual(argv, ["sh", "-lc", "uname -a"]);
    if (this.readinessHangs) return new Promise(() => {});
    if (this.readyGate) await this.readyGate;
    return { output: async () => ({ exitCode: this.exitCode }) };
  }
  async destroy() {
    this.destroys += 1;
    if (this.destroyError) throw this.destroyError;
    this.running = false;
  }
}

function fixture(initialTime = Date.UTC(2026, 9, 5, 12), timers = globalThis) {
  let now = initialTime;
  const ctx = { storage: new MemoryStorage(), container: new FakeContainer() };
  const controller = new UserContainerController(ctx, () => now, timers);
  const setTime = (time) => { now = time; };
  const request = (method = "GET") => controller.fetch(new Request("https://builder.test/container", { method, headers: { "x-mainbrella-plan": "builder", "x-mainbrella-paid-until": String(now + 30 * 86400000) } }));
  const read = async (method = "GET") => {
    const response = await request(method);
    return { response, body: await response.json() };
  };
  return { ctx, controller, request, read, setTime, now: () => now };
}

test("concurrent POSTs reject a second container and reserve only one monthly start", async () => {
  const f = fixture();
  let releaseReadiness;
  f.ctx.container.readyGate = new Promise((resolve) => { releaseReadiness = resolve; });
  const first = f.request("POST");
  const second = f.request("POST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.ctx.container.starts, 1);
  releaseReadiness();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.deepEqual(await b.json(), { error: "container_limit_exceeded" });
  const result = (await f.read()).body;
  assert.equal(result.plan, "builder");
  assert.deepEqual(result.containers.map(({ id, name, instance, status }) => ({ id, name, instance, status })), [
    { id: "small", name: "Small container", instance: "lite", status: "running" },
  ]);
  assert.equal(result.usage.starts, 1);
  assert.deepEqual(result.limits, {
    maxContainers: 5,
    maxStartsPerMonth: 10,
    maxSessionMs: 3_600_000,
    idleTimeoutMs: 600_000,
  });
  assert.equal(f.ctx.container.startOptions[0].image, f.ctx.container.images.terminal);
  assert.deepEqual(f.ctx.container.startOptions[0].entrypoint, ["sleep", "infinity"]);
  assert.equal(f.ctx.container.startOptions[0].enableInternet, true);
  assert.equal(f.ctx.storage.alarmAt, f.now() + 600_000);
  assert.equal(f.ctx.container.inactivityTimeouts[0], 600_000);
});

test("GET is read-only and DELETE stops without erasing monthly usage", async () => {
  const f = fixture();
  await f.read("POST");
  const alarmAt = f.ctx.storage.alarmAt;
  await f.read();
  assert.equal(f.ctx.storage.alarmAt, alarmAt);
  assert.equal(f.ctx.container.inactivityTimeouts.length, 1);
  const { body } = await f.read("DELETE");
  assert.deepEqual(body.containers, []);
  assert.equal(body.usage.starts, 1);
  assert.equal(f.ctx.storage.alarmAt, null);
});


test("hard expiry is enforced by GET even when the alarm has not run", async () => {
  const f = fixture();
  const created = await f.read("POST");
  const expectedExpiry = new Date(f.now() + 3_600_000).toISOString();
  assert.equal(created.body.containers[0].expiresAt, expectedExpiry);
  f.setTime(f.now() + 3_600_000);
  const expired = await f.read();
  assert.deepEqual(expired.body.containers, []);
  assert.equal(f.ctx.container.running, false);
  assert.equal(expired.body.usage.starts, 1);
});

test("idle stop leaves usage intact and a later POST creates a fresh session", async () => {
  const f = fixture();
  const first = await f.read("POST");
  const firstCreatedAt = first.body.containers[0].createdAt;
  f.ctx.container.running = false; // The container runtime enforces its idle timeout.
  const idle = await f.read();
  assert.deepEqual(idle.body.containers, []);
  assert.equal(idle.body.usage.starts, 1);
  f.setTime(f.now() + 11 * 60_000);
  const next = await f.read("POST");
  assert.equal(next.body.containers[0].createdAt, new Date(f.now()).toISOString());
  assert.notEqual(next.body.containers[0].createdAt, firstCreatedAt);
  assert.equal(next.body.usage.starts, 2);
});

test("alarm destroys at the earliest idle deadline and keeps persisted metadata", async () => {
  const f = fixture();
  await f.read("POST");
  const metadata = await f.ctx.storage.get("builderMachine");
  assert.equal(f.ctx.storage.alarmAt, metadata.idleExpiresAt);
  f.setTime(metadata.idleExpiresAt);
  await f.controller.alarm();
  assert.equal(f.ctx.container.running, false);
  assert.deepEqual(await f.ctx.storage.get("builderMachine"), metadata);
});

test("restart and GET preserve the absolute idle deadline without renewing it", async () => {
  const f = fixture();
  await f.read("POST");
  const metadata = await f.ctx.storage.get("builderMachine");
  f.setTime(f.now() + 5 * 60_000);
  const restarted = new UserContainerController(f.ctx, f.now);
  const response = await restarted.fetch(new Request("https://builder.test/container", { headers: { "x-mainbrella-plan": "builder", "x-mainbrella-paid-until": String(f.now() + 30 * 86400000) } }));
  const body = await response.json();
  assert.equal(body.containers[0].expiresAt, new Date(metadata.expiresAt).toISOString());
  assert.equal(f.ctx.storage.alarmAt, metadata.idleExpiresAt);
  assert.equal(f.ctx.container.inactivityTimeouts.length, 1);

  f.setTime(metadata.idleExpiresAt);
  const expired = await restarted.fetch(new Request("https://builder.test/container", { headers: { "x-mainbrella-plan": "builder", "x-mainbrella-paid-until": String(f.now() + 30 * 86400000) } }));
  assert.deepEqual((await expired.json()).containers, []);
  assert.equal(f.ctx.container.running, false);
});

test("failed readiness cleans up the container but conservatively consumes quota", async () => {
  const f = fixture();
  f.ctx.container.exitCode = 7;
  const failed = await f.read("POST");
  assert.equal(failed.response.status, 500);
  assert.match(failed.body.error, /readiness check failed/);
  assert.equal(f.ctx.container.running, false);
  assert.equal(f.ctx.container.destroys, 1);
  assert.equal(f.ctx.storage.alarmAt, null);
  const status = await f.read();
  assert.equal(status.body.usage.starts, 1);
  assert.deepEqual(status.body.containers, []);
});

test("hanging readiness is bounded and destroys the machine", async () => {
  let timeoutMs;
  let cleared = false;
  const timers = {
    setTimeout(callback, milliseconds) {
      timeoutMs = milliseconds;
      queueMicrotask(callback);
      return "readiness-timer";
    },
    clearTimeout(timer) {
      assert.equal(timer, "readiness-timer");
      cleared = true;
    },
  };
  const f = fixture(Date.UTC(2026, 9, 5, 12), timers);
  f.ctx.container.readinessHangs = true;
  const result = await f.read("POST");
  assert.equal(result.response.status, 500);
  assert.match(result.body.error, /timed out after 60000 ms/);
  assert.equal(timeoutMs, 60_000);
  assert.equal(cleared, true);
  assert.equal(f.ctx.container.running, false);
  assert.equal(f.ctx.container.destroys, 1);
  assert.equal(f.ctx.storage.alarmAt, null);
});

test("failed cleanup preserves the hard-expiry alarm for retry", async () => {
  const f = fixture();
  f.ctx.container.exitCode = 9;
  f.ctx.container.destroyError = new Error("container API unavailable");
  const result = await f.read("POST");
  assert.equal(result.response.status, 500);
  assert.equal(f.ctx.container.running, true);
  assert.equal(f.ctx.storage.alarmAt, f.now() + 600_000);
});

test("running container without metadata is destroyed fail closed", async () => {
  const f = fixture();
  f.ctx.container.running = true;
  f.ctx.storage.alarmAt = f.now() + 3_600_000;
  const result = await f.read();
  assert.equal(f.ctx.container.running, false);
  assert.equal(f.ctx.container.destroys, 1);
  assert.equal(f.ctx.storage.alarmAt, null);
  assert.deepEqual(result.body.containers, []);
});


test("same-millisecond recreation gets a distinct generation and rejects old terminal access", async () => {
  const f = fixture();
  const first = (await f.read("POST")).body.containers[0];
  await f.read("DELETE");
  const second = (await f.read("POST")).body.containers[0];
  assert.notEqual(second.createdAt, first.createdAt);
  assert.equal(await f.controller.getTerminalMetadata(first.createdAt, Date.parse(first.expiresAt)), null);
  assert.ok(await f.controller.getTerminalMetadata(second.createdAt, Date.parse(second.expiresAt)));
});

for (const plan of ["builder", "pro", "scale"]) {
  test(`${plan} sessions are capped by paid expiration and use that plan's idle timeout`, async () => {
    const f = fixture();
    const paidUntil = f.now() + 100_000;
    const response = await f.controller.fetch(new Request("https://internal/container", { method: "POST", headers: {
      "x-mainbrella-plan": plan, "x-mainbrella-paid-until": String(paidUntil), "x-mainbrella-checked-at": String(f.now()),
    } }));
    const body = await response.json();
    assert.equal(body.plan, plan);
    assert.equal(Date.parse(body.containers[0].expiresAt), paidUntil);
    assert.equal(f.ctx.storage.alarmAt, paidUntil);
    f.setTime(paidUntil);
    await f.controller.alarm();
    assert.equal(f.ctx.container.running, false);
  });
}

test("a newer unpaid decision blocks an older paid start at the machine boundary", async () => {
  const f = fixture();
  const now = f.now();
  await f.controller.fetch(new Request("https://internal/container", { headers: {
    "x-mainbrella-plan": "", "x-mainbrella-paid-until": "0", "x-mainbrella-checked-at": String(now + 1),
  } }));
  const response = await f.controller.fetch(new Request("https://internal/container", { method: "POST", headers: {
    "x-mainbrella-plan": "scale", "x-mainbrella-paid-until": String(now + 30 * 86400000), "x-mainbrella-checked-at": String(now),
  } }));
  assert.equal(response.status, 402);
  assert.equal(f.ctx.container.starts, 0);
});

test('paid expiry during storage reads denies boot without consuming slot usage', async () => {
  const f = fixture(); const initial = f.now(); const original = f.ctx.storage.get.bind(f.ctx.storage);
  f.ctx.storage.get = async key => {
    const result = await original(key);
    if (key === 'builderMachineStarts') f.setTime(initial + 1000);
    return result;
  };
  const response = await f.controller.fetch(new Request('https://internal/container', { method: 'POST', headers: {
    'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(initial + 1000), 'x-mainbrella-checked-at': String(initial),
  } }));
  assert.equal(response.status, 402);
  assert.equal(f.ctx.container.starts, 0);
  assert.equal(await original('builderMachineStarts'), undefined);
});

test('expiry while persisting a reservation cannot launch an already expired machine', async () => {
  const f = fixture(); const initial = f.now(); const original = f.ctx.storage.setAlarm.bind(f.ctx.storage);
  f.ctx.storage.setAlarm = async at => { await original(at); f.setTime(initial + 1000); };
  const response = await f.controller.fetch(new Request('https://internal/container', { method: 'POST', headers: {
    'x-mainbrella-plan': 'builder', 'x-mainbrella-paid-until': String(initial + 1000), 'x-mainbrella-checked-at': String(initial),
  } }));
  assert.equal(response.status, 402); assert.equal(f.ctx.container.starts, 0);
  assert.equal(f.ctx.storage.alarmAt, null);
  assert.equal((await f.ctx.storage.get('builderMachineStarts'))['2026-10'], 1);
});

test('revocation closes terminal access even when platform destruction fails', async () => {
  const f = fixture(); await f.read('POST');
  const metadata = await f.ctx.storage.get('builderMachine'); const generation = new Date(metadata.createdAt).toISOString();
  let closed = false; f.controller.onStopped = () => { closed = true; };
  f.ctx.container.destroyError = new Error('platform unavailable');
  f.setTime(f.now() + 1);
  await assert.rejects(f.controller.fetch(new Request('https://internal/container', { method: 'DELETE', headers: {
    'x-mainbrella-checked-at': String(f.now()),
  } })), /platform unavailable/);
  assert.equal(closed, true); assert.equal(f.ctx.container.running, true);
  assert.equal(await f.controller.getTerminalMetadata(generation, metadata.expiresAt), null);
  assert.equal(await f.controller.touchTerminalActivity(generation), false);
  await assert.rejects(f.controller.startTerminalProcess(generation, metadata.expiresAt, ['bash'], {}), /Machine unavailable/);
  const restarted = new UserContainerController(f.ctx, f.now);
  assert.equal(await restarted.getTerminalMetadata(generation, metadata.expiresAt), null);
  f.ctx.container.destroyError = null; await restarted.alarm();
  assert.equal(f.ctx.container.running, false);
});
