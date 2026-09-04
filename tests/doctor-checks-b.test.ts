import { describe, expect, test } from "bun:test";
import { collectResults } from "../src/cli/doctor-framework.ts";
import { CHECKS_B, createChecksB, type ChecksBDeps } from "../src/cli/doctor-checks-b.ts";

function find(id: string, deps: ChecksBDeps = {}) {
  const check = createChecksB(deps).find((c) => c.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check;
}

describe("doctor checks batch B: closed port fails, never throws", () => {
  test("port:1090 closed -> fail with fixHint, not throw", async () => {
    const checks = createChecksB({ tcpProbe: async () => false });
    const target = checks.find((c) => c.id === "port:1090");
    if (!target) throw new Error("missing port:1090");
    const results = await collectResults([target]);
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toBe("fail");
    expect(results[0]?.fixHint?.length ?? 0).toBeGreaterThan(0);
  });

  test("port:20128 closed -> fail with fixHint, not throw", async () => {
    const results = await collectResults(
      createChecksB({ tcpProbe: async () => false }).filter((c) => c.id === "port:20128"),
    );
    expect(results[0]?.result).toBe("fail");
    expect(results[0]?.fixHint?.length ?? 0).toBeGreaterThan(0);
  });

  test("throwing probe still yields fail, never throws", async () => {
    const checks = createChecksB({
      tcpProbe: async () => {
        throw new Error("socket boom");
      },
    });
    const results = await collectResults(checks.filter((c) => c.id === "port:1090"));
    expect(results[0]?.result).toBe("fail");
  });

  test("port:1090 open -> pass", async () => {
    expect((await find("port:1090", { tcpProbe: async () => true }).run()).result).toBe("pass");
  });
});

describe("doctor checks batch B: stale pidfile fails with fixHint", () => {
  test("service:relay stale pidfile -> fail with fixHint", async () => {
    const checks = createChecksB({ readPidFn: () => null });
    const results = await collectResults(checks.filter((c) => c.id === "service:relay"));
    expect(results[0]?.result).toBe("fail");
    expect(results[0]?.fixHint?.length ?? 0).toBeGreaterThan(0);
  });

  test("service:sing-box live pid -> pass", async () => {
    expect((await find("service:sing-box", { readPidFn: () => 1234 }).run()).result).toBe("pass");
  });

  test("service:gateway pid alive + /api/health ok -> pass", async () => {
    const checks = createChecksB({
      readPidFn: () => 1234,
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    const results = await collectResults(checks.filter((c) => c.id === "service:gateway"));
    expect(results[0]?.result).toBe("pass");
  });

  test("service:gateway health down -> fail with fixHint", async () => {
    const checks = createChecksB({
      fetchImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const results = await collectResults(checks.filter((c) => c.id === "service:gateway"));
    expect(results[0]?.result).toBe("fail");
    expect(results[0]?.fixHint?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("doctor checks batch B: zen-endpoint full chain", () => {
  test("GET /v1/models with oc/ ids -> pass", async () => {
    const checks = createChecksB({
      fetchImpl: async (url: string) => {
        if (url.endsWith("/v1/models")) {
          return new Response(
            JSON.stringify({
              object: "list",
              data: [{ id: "oc/muse-spark-1.3-contributor-free" }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    const results = await collectResults(checks.filter((c) => c.id === "zen-endpoint"));
    expect(results[0]?.result).toBe("pass");
  });

  test("GET /v1/models without oc/ ids -> fail with fixHint", async () => {
    const checks = createChecksB({
      fetchImpl: async () =>
        new Response(JSON.stringify({ object: "list", data: [{ id: "other" }] }), { status: 200 }),
    });
    const results = await collectResults(checks.filter((c) => c.id === "zen-endpoint"));
    expect(results[0]?.result).toBe("fail");
    expect(results[0]?.fixHint?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("doctor checks batch B: scheduler is warn-only", () => {
  test("scheduler tasks absent -> warn, not fail", async () => {
    const checks = createChecksB({ queryScheduler: async () => "" });
    const results = await collectResults(checks.filter((c) => c.id === "scheduler"));
    expect(results[0]?.result).toBe("warn");
    expect(results[0]?.fixHint?.length ?? 0).toBeGreaterThan(0);
  });

  test("scheduler query throwing -> warn, not fail", async () => {
    const checks = createChecksB({
      queryScheduler: async () => {
        throw new Error("schtasks not found");
      },
    });
    const results = await collectResults(checks.filter((c) => c.id === "scheduler"));
    expect(results[0]?.result).toBe("warn");
  });

  test("all oc-* tasks present -> pass", async () => {
    const checks = createChecksB({
      queryScheduler: async () => "oc-singbox\noc-relay\noc-gateway\n",
    });
    const results = await collectResults(checks.filter((c) => c.id === "scheduler"));
    expect(results[0]?.result).toBe("pass");
  });

  test("CHECKS_B default export covers ports, services, endpoint, scheduler", () => {
    const ids = new Set(CHECKS_B.map((c) => c.id));
    for (const id of [
      "port:1090",
      "port:20128",
      "service:sing-box",
      "service:relay",
      "service:gateway",
      "zen-endpoint",
      "scheduler",
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});
