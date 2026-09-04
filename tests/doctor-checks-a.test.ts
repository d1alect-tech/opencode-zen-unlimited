import { describe, expect, test } from "bun:test";
import { collectResults, formatJson } from "../src/cli/doctor-framework.ts";
import {
  createBatchAChecks,
  type BatchAChecksDeps,
  type RunCmd,
} from "../src/cli/doctor-checks.ts";

const GOOD_CMDS: Record<string, { ok: boolean; stdout: string }> = {
  "bun --version": { ok: true, stdout: "1.3.14\n" },
  "node --version": { ok: true, stdout: "v22.12.0\n" },
  "bunx --version": { ok: true, stdout: "1.3.14\n" },
};

function stubCmd(overrides: Record<string, { ok: boolean; stdout: string }> = {}): RunCmd {
  const table = { ...GOOD_CMDS, ...overrides };
  return (cmd, args) => table[`${cmd} ${args.join(" ")}`] ?? { ok: false, stdout: "" };
}

const GOOD_ENV_FILE = "PORT=20128\nEGRESS_UPSTREAMS=socks5h://127.0.0.1:1081,socks5h://127.0.0.1:1082\n";

function deps(over: Partial<BatchAChecksDeps> = {}): BatchAChecksDeps {
  return {
    runCmd: stubCmd(),
    readEnvFile: () => GOOD_ENV_FILE,
    fileExists: () => true,
    platform: "win32",
    env: {},
    ...over,
  };
}

async function runOne(id: string, d: BatchAChecksDeps) {
  const check = createBatchAChecks(d).find((c) => c.id === id);
  expect(check).toBeDefined();
  const [record] = await collectResults([check!]);
  return record!;
}

describe("doctor batch A ordering", () => {
  test("cheap checks run before slow ones", () => {
    const ids = createBatchAChecks(deps()).map((c) => c.id);
    expect(ids).toEqual([
      "bun-runtime",
      "node-runtime",
      "package-manager",
      "config-env",
      "egress-upstreams",
      "config-secrets",
      "binary:sing-box",
      "firewall",
    ]);
  });
});

describe("doctor batch A runtime gates", () => {
  test("bun below 1.3.14 fails with install hint", async () => {
    const record = await runOne(
      "bun-runtime",
      deps({ runCmd: stubCmd({ "bun --version": { ok: true, stdout: "1.2.0\n" } }) }),
    );
    expect(record.result).toBe("fail");
    expect(record.fixHint).toContain("bun.sh");
  });

  test("bun missing from PATH fails", async () => {
    const record = await runOne(
      "bun-runtime",
      deps({ runCmd: stubCmd({ "bun --version": { ok: false, stdout: "" } }) }),
    );
    expect(record.result).toBe("fail");
    expect(record.fixHint?.length ?? 0).toBeGreaterThan(0);
  });

  test("node below 22 fails with install hint", async () => {
    const record = await runOne(
      "node-runtime",
      deps({ runCmd: stubCmd({ "node --version": { ok: true, stdout: "v20.11.0\n" } }) }),
    );
    expect(record.result).toBe("fail");
    expect(record.fixHint).toContain("nodejs.org");
  });

  test("current runtimes pass", async () => {
    for (const id of ["bun-runtime", "node-runtime", "package-manager"] as const) {
      const record = await runOne(id, deps());
      expect(record.result).toBe("pass");
    }
  });
});

describe("doctor batch A config-env", () => {
  test("missing .env file fails with copy hint", async () => {
    const record = await runOne("config-env", deps({ readEnvFile: () => undefined }));
    expect(record.result).toBe("fail");
    expect(record.detail).toContain(".env");
    expect(record.fixHint).toContain(".env.example");
  });

  test("env file missing PORT fails and names the key", async () => {
    const record = await runOne(
      "config-env",
      deps({ readEnvFile: () => "EGRESS_UPSTREAMS=\n" }),
    );
    expect(record.result).toBe("fail");
    expect(record.detail).toContain("PORT");
    expect(record.fixHint?.length ?? 0).toBeGreaterThan(0);
  });

  test("empty EGRESS_UPSTREAMS key still satisfies presence", async () => {
    const record = await runOne(
      "config-env",
      deps({ readEnvFile: () => "PORT=20128\nEGRESS_UPSTREAMS=\n" }),
    );
    expect(record.result).toBe("pass");
  });
});

describe("doctor batch A egress-upstreams", () => {
  test("malformed EGRESS_UPSTREAMS fails without leaking values", async () => {
    const record = await runOne(
      "egress-upstreams",
      deps({ env: { EGRESS_UPSTREAMS: ":::not-a-url:::" } }),
    );
    expect(record.result).toBe("fail");
    expect(record.detail).not.toContain(":::not-a-url:::");
    expect(record.fixHint).toContain("EGRESS_UPSTREAMS");
  });

  test("empty EGRESS_UPSTREAMS warns (direct mode)", async () => {
    const record = await runOne(
      "egress-upstreams",
      deps({ env: { EGRESS_UPSTREAMS: "" } }),
    );
    expect(record.result).toBe("warn");
  });

  test("valid upstreams pass with count-only detail", async () => {
    const record = await runOne("egress-upstreams", deps());
    expect(record.result).toBe("pass");
    expect(record.detail).toContain("2 upstream(s)");
    expect(record.detail).not.toContain("127.0.0.1");
  });
});

describe("doctor batch A firewall is warn-only", () => {
  test("netsh failure yields warn, never fail", async () => {
    const record = await runOne(
      "firewall",
      deps({ runCmd: () => ({ ok: false, stdout: "" }) }),
    );
    expect(record.result).toBe("warn");
  });

  test("non-Windows skips with warn", async () => {
    const record = await runOne("firewall", deps({ platform: "linux" }));
    expect(record.result).toBe("warn");
  });
});

describe("doctor batch A json + redaction shape", () => {
  test("--json parses and redacts secret values", async () => {
    const results = await collectResults([
      {
        id: "cfg",
        group: "Config",
        run: () => ({ result: "pass", detail: "RR_WATCH_TOKEN=hunter2-secret" }),
      },
    ]);
    const parsed = JSON.parse(formatJson(results, "0.1.0", "win32")) as {
      ok: boolean;
      version: string;
      platform: string;
      checks: Array<{ id: string; detail?: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toHaveLength(1);
    expect(parsed.checks[0]?.detail).toContain("[redacted]");
    expect(parsed.checks[0]?.detail).not.toContain("hunter2-secret");
  });

  test("batch A --json payload carries no secret values", async () => {
    const secretFile = `${GOOD_ENV_FILE}HY2_PASSWORD=hunter2-live\nEGRESS_SUB_URL=https://sub.example/s3cret\n`;
    const results = await collectResults(
      createBatchAChecks(deps({ readEnvFile: () => secretFile })),
    );
    const raw = formatJson(results, "0.1.0", "win32");
    const parsed = JSON.parse(raw) as { ok: boolean; checks: unknown[] };
    expect(parsed.checks).toHaveLength(8);
    expect(raw).not.toContain("hunter2-live");
    expect(raw).not.toContain("https://sub.example/s3cret");
  });
});
