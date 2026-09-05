import { describe, expect, test } from "bun:test";
import {
  benchDurationMs,
  createRotationPool,
  DEFAULT_BENCH_MS,
  fetchWithRotation,
  MAX_BENCH_MS,
  parseRetryAfterMs,
  type FetchWithRotationResult,
} from "@/gateway/rotation";
import type {
  FetchImpl,
  UpstreamRequestInit,
} from "@/gateway/forward";

const EGRESS_A = "http://127.0.0.1:18081";
const EGRESS_B = "http://127.0.0.1:18082";

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

type Scripted = Response | Error;

/** Fault-injection fetch: replays a scripted 429/401/500 sequence. */
function scriptFetch(script: Scripted[]): {
  fetchImpl: FetchImpl;
} {
  let calls = 0;
  const fetchImpl: FetchImpl = (
    _url: string,
    _init: UpstreamRequestInit,
  ): Promise<Response> => {
    const next: Scripted | undefined = script[calls];
    calls += 1;
    if (next === undefined) {
      return Promise.resolve(jsonResponse({ output: "ok" }));
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  return { fetchImpl };
}

function trackingDispatcher(): {
  seen: string[];
  dispatcherFor: (egressUrl: string) => undefined;
} {
  const seen: string[] = [];
  return {
    seen,
    dispatcherFor: (egressUrl: string): undefined => {
      seen.push(egressUrl);
      return undefined;
    },
  };
}

describe("parseRetryAfterMs", () => {
  test("parses delay-seconds", () => {
    expect(parseRetryAfterMs("2", 1_000_000)).toBe(2_000);
  });

  test("invalid values yield undefined (default applies)", () => {
    expect(parseRetryAfterMs(null, 1_000_000)).toBeUndefined();
    expect(parseRetryAfterMs("nonsense", 1_000_000)).toBeUndefined();
    expect(parseRetryAfterMs("", 1_000_000)).toBeUndefined();
  });

  test("honors http-date", () => {
    const nowMs = 1_000_000;
    const date = new Date(nowMs + 30_000).toUTCString();
    expect(parseRetryAfterMs(date, nowMs)).toBe(30_000);
  });

  test("caps huge values", () => {
    expect(parseRetryAfterMs("999999", 1_000_000)).toBe(MAX_BENCH_MS);
  });
});

describe("benchDurationMs", () => {
  test("defaults to 60s without Retry-After", () => {
    expect(benchDurationMs(429, null, 1_000_000, () => 0)).toBe(
      DEFAULT_BENCH_MS,
    );
  });

  test("honors Retry-After seconds", () => {
    expect(benchDurationMs(429, "120", 1_000_000, () => 0)).toBe(120_000);
  });

  test("401/403 bench with the default window", () => {
    expect(benchDurationMs(401, null, 1_000_000, () => 0)).toBe(
      DEFAULT_BENCH_MS,
    );
    expect(benchDurationMs(403, null, 1_000_000, () => 0)).toBe(
      DEFAULT_BENCH_MS,
    );
  });
});

describe("createRotationPool", () => {
  test("pins the first egress, skips benched ones", () => {
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    expect(pool.pick()).toBe(EGRESS_A);
    pool.bench(EGRESS_A, 60_000);
    expect(pool.pick()).toBe(EGRESS_B);
  });

  test("returns undefined when every egress is benched", () => {
    const pool = createRotationPool([EGRESS_A]);
    pool.bench(EGRESS_A, 60_000);
    expect(pool.pick()).toBeUndefined();
  });

  test("rotate moves the pin without benching", () => {
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    pool.rotate();
    expect(pool.pick()).toBe(EGRESS_B);
  });
});

describe("fetchWithRotation fault-injection matrix", () => {
  const baseInit: UpstreamRequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  };

  test("429 rotates to the next egress and retries", async () => {
    const { seen, dispatcherFor } = trackingDispatcher();
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    const seq = scriptFetch([
      jsonResponse({ error: "quota" }, 429),
      jsonResponse({ output: "ok" }, 200),
    ]);
    const result: FetchWithRotationResult = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      dispatcherFor,
      random: () => 0,
    });
    expect(result.res.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(seen).toEqual([EGRESS_A, EGRESS_B]);
    expect(pool.benchedUntil(EGRESS_A)).toBeGreaterThan(Date.now());
  });

  test("Retry-After seconds set the bench window", async () => {
    const nowMs = 1_000_000;
    const pool = createRotationPool([EGRESS_A, EGRESS_B], () => nowMs);
    const seq = scriptFetch([
      jsonResponse({ error: "quota" }, 429, { "retry-after": "120" }),
      jsonResponse({ output: "ok" }, 200),
    ]);
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      now: () => nowMs,
      random: () => 0,
    });
    expect(result.res.status).toBe(200);
    expect(pool.benchedUntil(EGRESS_A)).toBe(1_000_000 + 120_000);
  });

  test("401 benches without retrying the same egress", async () => {
    const { seen, dispatcherFor } = trackingDispatcher();
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    const seq = scriptFetch([
      jsonResponse({ error: "unauthorized" }, 401),
      jsonResponse({ output: "ok" }, 200),
    ]);
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      dispatcherFor,
      random: () => 0,
    });
    expect(result.res.status).toBe(200);
    expect(seen).toEqual([EGRESS_A, EGRESS_B]);
    expect(pool.benchedUntil(EGRESS_A)).toBeGreaterThan(Date.now());
  });

  test("5xx goes to the next egress once", async () => {
    const { seen, dispatcherFor } = trackingDispatcher();
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    const seq = scriptFetch([
      jsonResponse({ error: "boom" }, 500),
      jsonResponse({ output: "ok" }, 200),
    ]);
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      dispatcherFor,
      random: () => 0,
    });
    expect(result.res.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(seen).toEqual([EGRESS_A, EGRESS_B]);
  });

  test("timeout retries the next egress", async () => {
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    const seq = scriptFetch([
      new Error("timeout"),
      jsonResponse({ output: "ok" }, 200),
    ]);
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      random: () => 0,
    });
    expect(result.res.status).toBe(200);
    expect(result.attempts).toBe(2);
  });

  test("fetch rejection benches the stalled egress", async () => {
    const nowMs = 2_000_000;
    const { seen, dispatcherFor } = trackingDispatcher();
    const pool = createRotationPool([EGRESS_A, EGRESS_B], () => nowMs);
    const seq = scriptFetch([
      new Error("body timeout"),
      jsonResponse({ output: "ok" }, 200),
    ]);
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      dispatcherFor,
      now: () => nowMs,
      random: () => 0,
    });
    expect(result.res.status).toBe(200);
    expect(result.attempts).toBe(2);
    expect(seen).toEqual([EGRESS_A, EGRESS_B]);
    expect(pool.benchedUntil(EGRESS_A)).toBe(nowMs + DEFAULT_BENCH_MS);
    expect(pool.benchedUntil(EGRESS_B)).toBe(0);
  });

  test("client abort surfaces without benching", async () => {
    const nowMs = 3_000_000;
    const pool = createRotationPool([EGRESS_A, EGRESS_B], () => nowMs);
    const seq = scriptFetch([new Error("aborted")]);
    const promise = fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      clientSignal: AbortSignal.abort(),
      now: () => nowMs,
      random: () => 0,
    });
    await expect(promise).rejects.toThrow();
    expect(pool.benchedUntil(EGRESS_A)).toBe(0);
    expect(pool.benchedUntil(EGRESS_B)).toBe(0);
  });

  test("other 4xx map 1:1 with no retry", async () => {
    const pool = createRotationPool([EGRESS_A, EGRESS_B]);
    const seq = scriptFetch([jsonResponse({ error: "bad" }, 400)]);
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A, EGRESS_B],
      pool,
      random: () => 0,
    });
    expect(result.res.status).toBe(400);
    expect(result.attempts).toBe(1);
  });

  test("5 consecutive 429s surface 429 with gateway retry-after", async () => {
    const egresses = [
      "http://127.0.0.1:18081",
      "http://127.0.0.1:18082",
      "http://127.0.0.1:18083",
      "http://127.0.0.1:18084",
      "http://127.0.0.1:18085",
    ];
    const pool = createRotationPool(egresses);
    const seq = scriptFetch(
      egresses.map(() =>
        jsonResponse({ error: "quota" }, 429, {
          "x-request-id": "req-429",
        }),
      ),
    );
    const result = await fetchWithRotation({
      fetchImpl: seq.fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses,
      pool,
      random: () => 0,
    });
    expect(result.attempts).toBe(5);
    expect(result.res.status).toBe(429);
    expect(result.res.headers.get("x-request-id")).toBe("req-429");
    expect(await result.res.json()).toEqual({ error: "quota" });
    const retryAfter = result.res.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test("single benched egress yields gateway-own 429 with retry-after", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ error: "quota" }, 429));
    };
    const pool = createRotationPool([EGRESS_A]);
    const result = await fetchWithRotation({
      fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [EGRESS_A],
      pool,
      random: () => 0,
    });
    expect(calls).toBe(1);
    expect(result.provenance).toBe("gateway");
    expect(result.res.status).toBe(429);
    expect(result.res.headers.get("retry-after")).not.toBeNull();
    const body = (await result.res.json()) as {
      error: { message: string; type: string };
    };
    expect(body.error.type).toBe("gateway_rate_limited");
    expect(body.error.message).toContain("add-sub");
    expect(body.error.message).toContain("zen add-sub");
    expect(body.error.message).toContain("wait for reset");
    expect(body.error.message).toContain(
      `retry after ${result.res.headers.get("retry-after")} s`,
    );
  });

  test("empty pool stays direct with a single 1:1 attempt", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ error: "quota" }, 429));
    };
    const result = await fetchWithRotation({
      fetchImpl,
      url: "https://opencode.ai/zen/v1/responses",
      init: baseInit,
      egresses: [],
      random: () => 0,
    });
    expect(calls).toBe(1);
    expect(result.res.status).toBe(429);
    expect(await result.res.json()).toEqual({ error: "quota" });
  });
});
