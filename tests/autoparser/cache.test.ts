import { describe, expect, test } from "bun:test";
import {
  CACHE_TTL_MS,
  MIN_POLL_INTERVAL_MS,
  ModelCache,
  REFRESH_INTERVAL_MS,
} from "@/autoparser/cache";
import type { NormalizedModel } from "@/autoparser/fetcher";

function m(id: string): NormalizedModel {
  return { id, name: id };
}

describe("cache timing constants (omniroute precedent)", () => {
  test("5min TTL / 5min refresh / 60s min-interval", () => {
    expect(CACHE_TTL_MS).toBe(300_000);
    expect(REFRESH_INTERVAL_MS).toBe(300_000);
    expect(MIN_POLL_INTERVAL_MS).toBe(60_000);
  });
});

describe("ModelCache", () => {
  test("serves stale cache on fetch failure after TTL", async () => {
    const primed: NormalizedModel[] = [m("big-pickle"), m("a-free")];
    let calls = 0;
    const load = async (): Promise<NormalizedModel[]> => {
      calls += 1;
      if (calls === 1) return primed;
      throw new Error("upstream down");
    };
    const cache = new ModelCache(load);
    const first = await cache.refresh({ now: 1_000 });
    expect(first.map((x) => x.id)).toEqual(["big-pickle", "a-free"]);

    // Past TTL + past min-interval, upstream fails -> stale served, no throw.
    const second = await cache.refresh({ now: 1_000 + CACHE_TTL_MS + MIN_POLL_INTERVAL_MS + 1 });
    expect(second.map((x) => x.id)).toEqual(["big-pickle", "a-free"]);
    expect(cache.getSnapshot().map((x) => x.id)).toEqual(["big-pickle", "a-free"]);
  });

  test("min-interval clamps rapid polls (60s)", async () => {
    let calls = 0;
    const load = async (): Promise<NormalizedModel[]> => {
      calls += 1;
      return [m(`model-${calls}-free`)];
    };
    const cache = new ModelCache(load);
    await cache.refresh({ now: 10_000 });
    expect(calls).toBe(1);
    // 10s later (< 60s min-interval) -> clamped, loader not called again.
    const clamped = await cache.refresh({ now: 20_000 });
    expect(calls).toBe(1);
    expect(clamped.map((x) => x.id)).toEqual(["model-1-free"]);
    // After 61s -> allowed.
    const next = await cache.refresh({ now: 10_000 + MIN_POLL_INTERVAL_MS + 1 });
    expect(calls).toBe(2);
    expect(next.map((x) => x.id)).toEqual(["model-2-free"]);
  });

  test("force bypasses min-interval clamp", async () => {
    let calls = 0;
    const load = async (): Promise<NormalizedModel[]> => {
      calls += 1;
      return [m("a-free")];
    };
    const cache = new ModelCache(load);
    await cache.refresh({ now: 5_000 });
    await cache.refresh({ now: 6_000, force: true });
    expect(calls).toBe(2);
  });

  test("isStale reflects 5min TTL", async () => {
    const cache = new ModelCache(async () => [m("a-free")]);
    expect(cache.isStale(1_000)).toBe(true);
    await cache.refresh({ now: 1_000 });
    expect(cache.isStale(1_000 + CACHE_TTL_MS - 1)).toBe(false);
    expect(cache.isStale(1_000 + CACHE_TTL_MS)).toBe(true);
  });
});
