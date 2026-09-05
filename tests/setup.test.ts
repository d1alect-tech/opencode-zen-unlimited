import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, type SetupDeps } from "../src/cli/commands/setup.ts";
import { parseCliArgs } from "../src/cli/parser.ts";

const ENV_EXAMPLE = [
  "# fixture .env.example",
  "PORT=20128",
  "EGRESS_UPSTREAMS=",
  "EGRESS_SUB_URL=YOUR_SUB_URL",
  "HY2_PASSWORD=YOUR_HY2_PASSWORD",
  "",
].join("\n");

const SINGBOX_EXAMPLE = JSON.stringify(
  { log: { level: "info" }, outbounds: [{ type: "hysteria2", password: "YOUR_HY2_PASSWORD" }] },
  null,
  2,
);

function tmpRoot(): string {
  const dir = join(tmpdir(), `zen-setup-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, "sing-box"), { recursive: true });
  writeFileSync(join(dir, ".env.example"), ENV_EXAMPLE, "utf8");
  writeFileSync(join(dir, "sing-box", "config.example.json"), SINGBOX_EXAMPLE, "utf8");
  return dir;
}

function baseDeps(root: string, overrides?: Partial<SetupDeps>): SetupDeps {
  return {
    projectRoot: root,
    pidDir: join(root, "pids"),
    logDir: join(root, "logs"),
    platform: "win32",
    runCmd: () => ({ ok: true, stdout: "sing-box version 1.14.1" }),
    execScheduler: () => ({ ok: true, stdout: "registered" }),
    ...overrides,
  };
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

describe("zen setup command", () => {
  test("parser passes --dry-run/--yes through for setup", () => {
    const parsed = parseCliArgs(["setup", "--dry-run", "--yes"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.subcommand).toBe("setup");
      expect(parsed.rest).toContain("--dry-run");
      expect(parsed.rest).toContain("--yes");
    }
  });

  test("--dry-run changes nothing + prints full plan, exit 0", async () => {
    const root = tmpRoot();
    const r = await capture(() => runSetup(["--dry-run"], baseDeps(root)));
    expect(r.code).toBe(0);
    expect(existsSync(join(root, ".env"))).toBe(false);
    expect(existsSync(join(root, "sing-box", "config.json"))).toBe(false);
    expect(existsSync(join(root, "pids"))).toBe(false);
    expect(existsSync(join(root, "logs"))).toBe(false);
    for (const line of ["pids", "logs", "sing-box", ".env", "config.json", "install-zen-stack", "add-sub", "doctor"]) {
      expect(r.out).toContain(line);
    }
  });

  test("real run is idempotent: second run exit 0, no overwrite of existing .env", async () => {
    const root = tmpRoot();
    const first = await capture(() => runSetup([], baseDeps(root)));
    expect(first.code).toBe(0);
    expect(existsSync(join(root, ".env"))).toBe(true);
    expect(existsSync(join(root, "sing-box", "config.json"))).toBe(true);
    // User customizes .env after first run; rerun must not clobber it.
    writeFileSync(join(root, ".env"), "PORT=20128\nEGRESS_UPSTREAMS=socks5h://127.0.0.1:1081\n", "utf8");
    const second = await capture(() => runSetup([], baseDeps(root)));
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/skip.*\.env/i);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("socks5h://127.0.0.1:1081");
  });

  test("missing sing-box without --yes -> exit 1 with fixHint", async () => {
    const root = tmpRoot();
    const r = await capture(() =>
      runSetup(
        [],
        baseDeps(root, {
          fileExists: () => false,
          runCmd: () => ({ ok: false, stdout: "" }),
        }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/sing-box/i);
    expect(r.err).toMatch(/1\.14\.0|--yes/);
    // Failed before writing anything.
    expect(existsSync(join(root, ".env"))).toBe(false);
  });

  test("missing sing-box with --yes -> proceeds with download note, exit 0", async () => {
    const root = tmpRoot();
    const r = await capture(() =>
      runSetup(
        ["--yes"],
        baseDeps(root, {
          fileExists: () => false,
          runCmd: () => ({ ok: false, stdout: "" }),
        }),
      ),
    );
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/sing-box.*1\.14\.0/i);
    expect(existsSync(join(root, ".env"))).toBe(true);
  });

  test("sing-box below pin (>=1.14.0) without --yes -> exit 1", async () => {
    const root = tmpRoot();
    const r = await capture(() =>
      runSetup(
        [],
        baseDeps(root, { runCmd: () => ({ ok: true, stdout: "sing-box version 1.13.0" }) }),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/1\.14\.0/);
  });

  test("unknown flag -> exit 2 with usage", async () => {
    const r = await capture(() => runSetup(["--nope"], baseDeps(tmpRoot())));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/i);
  });
});
