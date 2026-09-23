import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStatus } from "../src/cli/commands/status.ts";
import { parseCliArgs } from "../src/cli/parser.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zen-status-"));
}

async function capture(fn: () => number | Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]): void => {
    outLines.push(a.map(String).join(" "));
  };
  console.error = (...a: unknown[]): void => {
    errLines.push(a.map(String).join(" "));
  };
  try {
    const code = await fn();
    return { code, out: outLines.join("\n"), err: errLines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

/** A pid that cannot be alive: readPid treats it as stale and cleans up. */
function writeStalePid(dir: string, name: string): void {
  writeFileSync(join(dir, `${name}.pid`), "2147483647\n", "utf8");
}

describe("zen status command", () => {
  test("parser passes --json/--self-heal/--verbose through for status", () => {
    const parsed = parseCliArgs(["status", "--json", "--self-heal", "--verbose"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.subcommand).toBe("status");
      expect(parsed.rest).toContain("--json");
      expect(parsed.rest).toContain("--self-heal");
      expect(parsed.rest).toContain("--verbose");
    }
  });

  test("stale pidfile -> dead row, exit 1", async () => {
    const pidDir = tmp();
    writeStalePid(pidDir, "singbox");
    writeStalePid(pidDir, "relay");
    writeStalePid(pidDir, "gateway");
    const r = await capture(() =>
      runStatus([], {
        pidDir,
        logDir: tmp(),
        tcpProbe: async () => false,
        fetchImpl: async () => new Response("no", { status: 500 }),
      }),
    );
    expect(r.code).toBe(1);
    for (const name of ["singbox", "relay", "gateway"]) {
      expect(r.out).toMatch(new RegExp(`${name}\\s+dead`));
    }
  });

  test("--json emits {ok, services[]} with pid/uptimeMs/detail", async () => {
    const pidDir = tmp();
    writeStalePid(pidDir, "singbox");
    writeStalePid(pidDir, "relay");
    writeStalePid(pidDir, "gateway");
    const r = await capture(() =>
      runStatus(["--json"], {
        pidDir,
        logDir: tmp(),
        tcpProbe: async () => false,
        fetchImpl: async () => new Response("no", { status: 500 }),
      }),
    );
    expect(r.code).toBe(1);
    const body = JSON.parse(r.out) as {
      ok: boolean;
      services: { name: string; alive: boolean; pid: number | null; uptimeMs: number | null; detail: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.services.map((s) => s.name)).toEqual(["singbox", "relay", "gateway"]);
    for (const s of body.services) {
      expect(s.alive).toBe(false);
      expect(s.pid).toBeNull();
      expect(s.uptimeMs).toBeNull();
      expect(typeof s.detail).toBe("string");
    }
  });

  test("--self-heal with fake spawner -> healed lines + exit 0", async () => {
    const pidDir = tmp();
    const logDir = tmp();
    const spawned: string[] = [];
    const notified: string[] = [];
    const r = await capture(() =>
      runStatus(["--self-heal"], {
        pidDir,
        logDir,
        tcpProbe: async () => false,
        fetchImpl: async () => new Response("no", { status: 500 }),
        spawnFn: (cmd, _args, opts) => {
          spawned.push(`${opts.name}:${cmd}`);
          return 4242;
        },
        notifyFn: (proc) => {
          notified.push(proc);
        },
      }),
    );
    expect(r.code).toBe(0);
    for (const name of ["singbox", "relay", "gateway"]) {
      expect(r.out).toContain(`healed ${name}`);
    }
    expect(spawned).toHaveLength(3);
    expect(notified.sort()).toEqual(["gateway", "relay", "singbox"]);
  });

  test("--self-heal still-down when spawner throws -> failed lines + exit 1", async () => {
    const pidDir = tmp();
    const r = await capture(() =>
      runStatus(["--self-heal"], {
        pidDir,
        logDir: tmp(),
        tcpProbe: async () => false,
        fetchImpl: async () => new Response("no", { status: 500 }),
        spawnFn: () => {
          throw new Error("no binary");
        },
        notifyFn: () => {},
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/failed singbox/);
    expect(r.out).toMatch(/failed relay/);
    expect(r.out).toMatch(/failed gateway/);
  });

  test("port open without pidfile -> alive rows, exit 0 (scheduler-run stack)", async () => {
    const r = await capture(() =>
      runStatus([], {
        pidDir: tmp(),
        logDir: tmp(),
        tcpProbe: async () => true,
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }),
    );
    expect(r.code).toBe(0);
    for (const name of ["singbox", "relay", "gateway"]) {
      expect(r.out).toMatch(new RegExp(`${name}\\s+alive`));
    }
  });

  test("--self-heal spawns nothing when ports open but pidfiles missing", async () => {
    const spawned: string[] = [];
    const r = await capture(() =>
      runStatus(["--self-heal"], {
        pidDir: tmp(),
        logDir: tmp(),
        tcpProbe: async () => true,
        fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        spawnFn: (_cmd, _args, opts) => {
          spawned.push(opts.name);
          return 4242;
        },
        notifyFn: () => {},
      }),
    );
    expect(r.code).toBe(0);
    expect(spawned).toHaveLength(0);
    expect(r.out).not.toContain("healed");
  });

  test("gateway port held but health failing -> dead, NOT re-spawned", async () => {
    const spawned: string[] = [];
    const r = await capture(() =>
      runStatus(["--self-heal"], {
        pidDir: tmp(),
        logDir: tmp(),
        tcpProbe: async (_host, port) => port === 20128,
        fetchImpl: async () => {
          throw new Error("socket hangup");
        },
        spawnFn: (_cmd, _args, opts) => {
          spawned.push(opts.name);
          return 4242;
        },
        notifyFn: () => {},
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/gateway\s+dead/);
    expect(spawned.sort()).toEqual(["relay", "singbox"]);
    expect(r.out).not.toContain("healed gateway");
  });

  test("unknown flag -> exit 2 with usage", async () => {
    const r = await capture(() => runStatus(["--nope"], { pidDir: tmp(), logDir: tmp() }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/i);
  });
});
