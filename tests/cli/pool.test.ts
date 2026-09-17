import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runPool } from "../../src/cli/commands/pool.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const POOL_STATE = {
  total: 2,
  healthy: 1,
  entries: [
    {
      egressUrl: "socks5h://127.0.0.1:1081",
      healthy: true,
      benchedMsRemaining: 0,
    },
    {
      egressUrl: "socks5h://127.0.0.1:1082",
      healthy: false,
      benchedMsRemaining: 899_000,
    },
  ],
};

const POOL_HEALTHY = {
  total: 2,
  healthy: 2,
  entries: POOL_STATE.entries.map((e) => ({
    ...e,
    healthy: true,
    benchedMsRemaining: 0,
  })),
};

interface FetchCall {
  url: string;
  method: string;
}

function stubFetch(handler: (url: string, method: string) => Response): {
  calls: FetchCall[];
  fetchImpl: (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<Response>;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (
    url: string,
    init?: { method?: string; signal?: AbortSignal },
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return Promise.resolve(handler(url, method));
  };
  return { calls, fetchImpl };
}

describe("zen pool", () => {
  let logs: string[] = [];
  let errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  beforeEach(() => {
    logs = [];
    errors = [];
    console.log = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]): void => {
      errors.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
  });

  test("status rows plus summary, exit 0", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(POOL_STATE));
    const code = await runPool([], { fetchImpl });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toMatch(/1081/);
    expect(out).toMatch(/bench/);
    expect(out).toMatch(/14m59s/);
    expect(out).toMatch(/1\/2 healthy/);
  });

  test("--json prints the machine shape", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(POOL_STATE));
    const code = await runPool(["--json"], { fetchImpl });
    expect(code).toBe(0);
    const body = JSON.parse(logs.join("\n")) as typeof POOL_STATE;
    expect(body.total).toBe(2);
    expect(body.healthy).toBe(1);
  });

  test("--reset posts reset then shows fresh state", async () => {
    const { calls, fetchImpl } = stubFetch((url, method) =>
      method === "POST" && url.endsWith("/api/pool/reset")
        ? jsonResponse({ reset: true, cleared: 1 })
        : jsonResponse(POOL_HEALTHY),
    );
    const code = await runPool(["--reset"], { fetchImpl });
    expect(code).toBe(0);
    expect(calls.some((c) => c.method === "POST")).toBe(true);
    expect(logs.join("\n")).toMatch(/cleared 1/);
  });

  test("gateway down -> exit 1 with reason", async () => {
    const code = await runPool([], {
      fetchImpl: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/error:/i);
  });

  test("unknown flag -> exit 2", async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(POOL_STATE));
    const code = await runPool(["--nope"], { fetchImpl });
    expect(code).toBe(2);
  });
});
