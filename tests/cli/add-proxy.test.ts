import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAddProxy } from "../../src/cli/commands/add-proxy.ts";
import { parseCliArgs } from "../../src/cli/parser.ts";
import { formatHelp } from "../../src/cli/help.ts";

describe("zen add-proxy", () => {
  let dir = "";
  let envPath = "";
  let logs: string[] = [];
  let errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zen-add-proxy-"));
    envPath = join(dir, ".env");
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

  test("missing url -> exit 2 + usage", async () => {
    const code = await runAddProxy([], { envPath });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage/i);
  });

  test("unknown flag -> exit 2", async () => {
    const code = await runAddProxy(["http://127.0.0.1:8080", "--nope"], {
      envPath,
    });
    expect(code).toBe(2);
  });

  test("invalid URL rejected with exit 2, file untouched", async () => {
    const before = readFileSync(envPath, "utf8");
    const code = await runAddProxy(["not-a-url"], { envPath });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/error:/i);
    expect(readFileSync(envPath, "utf8")).toBe(before);
    expect(existsSync(`${envPath}.bak`)).toBe(false);
  });

  test("non-proxy scheme (vless:) rejected with exit 2", async () => {
    const code = await runAddProxy(["vless://user@example.com:443"], {
      envPath,
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/error:/i);
  });

  test("http URL with auth appended, .bak written, secrets redacted", async () => {
    const code = await runAddProxy(["http://user:pass@127.0.0.1:8080"], {
      envPath,
    });
    expect(code).toBe(0);
    expect(existsSync(`${envPath}.bak`)).toBe(true);
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain(
      "EGRESS_UPSTREAMS=http://user:pass@127.0.0.1:8080",
    );
    const out = logs.join("\n");
    expect(out).toMatch(/added 1/);
    expect(out).toMatch(/zen doctor/);
    expect(out).not.toContain("user:pass");
  });

  test("https URL without auth accepted", async () => {
    const code = await runAddProxy(["https://127.0.0.1:8443"], { envPath });
    expect(code).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain(
      "EGRESS_UPSTREAMS=https://127.0.0.1:8443",
    );
  });

  test("socks5 URL still accepted", async () => {
    const code = await runAddProxy(["socks5h://127.0.0.1:1081"], { envPath });
    expect(code).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain(
      "EGRESS_UPSTREAMS=socks5h://127.0.0.1:1081",
    );
  });

  test("appends without overwriting existing entries", async () => {
    writeFileSync(
      envPath,
      "PORT=20128\nEGRESS_UPSTREAMS=socks5h://127.0.0.1:1081\n",
      "utf8",
    );
    const code = await runAddProxy(["http://127.0.0.1:8080"], { envPath });
    expect(code).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain(
      "EGRESS_UPSTREAMS=socks5h://127.0.0.1:1081,http://127.0.0.1:8080",
    );
  });

  test("rerun is idempotent (no dup entries)", async () => {
    expect(await runAddProxy(["http://127.0.0.1:8080"], { envPath })).toBe(0);
    logs = [];
    expect(await runAddProxy(["http://127.0.0.1:8080"], { envPath })).toBe(0);
    const env = readFileSync(envPath, "utf8");
    const line = env.split("\n").find((l) => l.startsWith("EGRESS_UPSTREAMS=")) ?? "";
    expect(line.split("http://127.0.0.1:8080").length - 1).toBe(1);
    expect(logs.join("\n")).toMatch(/added 0/);
  });

  test("multiple URLs in one call all appended", async () => {
    const code = await runAddProxy(
      ["http://127.0.0.1:8080", "https://127.0.0.1:8443"],
      { envPath },
    );
    expect(code).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain(
      "EGRESS_UPSTREAMS=http://127.0.0.1:8080,https://127.0.0.1:8443",
    );
  });

  test("one bad URL rejects the whole call, file untouched", async () => {
    const before = readFileSync(envPath, "utf8");
    const code = await runAddProxy(
      ["http://127.0.0.1:8080", "vless://user@example.com:443"],
      { envPath },
    );
    expect(code).toBe(2);
    expect(readFileSync(envPath, "utf8")).toBe(before);
  });

  test("missing .env is created with the key", async () => {
    const fresh = join(dir, "fresh.env");
    const code = await runAddProxy(["http://127.0.0.1:8080"], {
      envPath: fresh,
    });
    expect(code).toBe(0);
    expect(readFileSync(fresh, "utf8")).toContain(
      "EGRESS_UPSTREAMS=http://127.0.0.1:8080",
    );
    expect(existsSync(`${fresh}.bak`)).toBe(false);
  });

  test("duplicate URLs within one call appended once", async () => {
    const code = await runAddProxy(
      ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
      { envPath },
    );
    expect(code).toBe(0);
    const env = readFileSync(envPath, "utf8");
    const line = env.split("\n").find((l) => l.startsWith("EGRESS_UPSTREAMS=")) ?? "";
    expect(line.split("http://127.0.0.1:8080").length - 1).toBe(1);
    expect(logs.join("\n")).toMatch(/added 1/);
  });
});

describe("zen add-proxy routing", () => {
  test("add-proxy parses as a subcommand", () => {
    const parsed = parseCliArgs(["add-proxy", "http://127.0.0.1:8080"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.subcommand).toBe("add-proxy");
      expect(parsed.rest).toEqual(["http://127.0.0.1:8080"]);
    }
  });

  test("--help lists add-proxy", () => {
    expect(formatHelp()).toContain("add-proxy");
  });
});
