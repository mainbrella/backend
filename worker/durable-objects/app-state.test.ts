import test from "node:test";
import assert from "node:assert/strict";
import { AppState } from "./app-state";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test("AppState persists its visit count", async () => {
  const state = new AppState({ storage: new MemoryStorage() } as unknown as DurableObjectState);

  const first = await state.fetch(new Request("https://internal/state"));
  const second = await state.fetch(new Request("https://internal/state"));

  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(second.headers.get("cache-control"), "no-store");
  assert.deepEqual(await first.json(), { visits: 1 });
  assert.deepEqual(await second.json(), { visits: 2 });
});
