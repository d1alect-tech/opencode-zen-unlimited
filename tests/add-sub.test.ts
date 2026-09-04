import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAddSub } from "../src/cli/commands/add-sub.ts";

const SAMPLE_SUB = [
  "vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com#n1",
  "trojan://fake-pass@example.net:8443?sni=example.net#n2",
].join("\n");

function stubFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("zen add-sub", () => {
  let dir = "";
  let configPath = "";
  let envPath = "";
  let logs: string[] = [];
  let errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zen-add-sub-"));
    mkdirSync(join(dir, "sing-box"), { recursive: true });
    configPath = join(dir, "sing-box", "config.json");
    envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({ outbounds: [], route: { final: "direct" } }, null, 2), "utf8");
    writeFileSync(envPath, "PORT=20128\nEGRESS_UPSTREAMS=\n", "utf8");
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

  test("ftp URL -> exit 2 with reason", async () => {
    const code = await runAddSub(["ftp://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/error:/i);
  });

  test("garbage URL -> exit 2", async () => {
    const code = await runAddSub(["not-a-url"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(2);
  });

  test("missing url -> exit 2 + usage", async () => {
    const code = await runAddSub([], { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage/i);
  });

  test("unknown flag -> exit 2", async () => {
    const code = await runAddSub(["https://example.com/sub", "--nope"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(2);
  });

  test("valid sub appends nodes, backups .env + config, redacts secrets", async () => {
    const code = await runAddSub(["https://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(0);
    expect(existsSync(`${envPath}.bak`)).toBe(true);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("EGRESS_SUB_URL=https://example.com/sub");
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string }>;
    };
    expect(cfg.outbounds.length).toBe(2);
    const out = logs.join("\n");
    expect(out).toMatch(/added 2 node/);
    expect(out).toMatch(/zen doctor/);
    expect(out).not.toContain("fake-pass");
    expect(out).not.toContain("11111111-2222");
  });

  test("rerun is idempotent (no dup nodes)", async () => {
    const deps = { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) };
    expect(await runAddSub(["https://example.com/sub"], deps)).toBe(0);
    logs = [];
    expect(await runAddSub(["https://example.com/sub"], deps)).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string }>;
    };
    expect(cfg.outbounds.length).toBe(2);
    expect(logs.join("\n")).toMatch(/added 0 node/);
  });

  test("malformed sub (zero valid nodes) -> exit 2 with reason", async () => {
    const code = await runAddSub(["https://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch("ssr://example.com:8388:origin:rc4:plain:fake#bad"),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/error:/i);
  });

  test("--name prefixes added tags", async () => {
    const code = await runAddSub(["https://example.com/sub", "--name", "t9"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string }>;
    };
    const tags = cfg.outbounds.map((o) => o.tag ?? "");
    expect(tags.every((t) => t.startsWith("t9-"))).toBe(true);
  });
});
