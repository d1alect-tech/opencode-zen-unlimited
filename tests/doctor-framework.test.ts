import { describe, expect, test } from "bun:test";
import {
  collectResults,
  computeExitCode,
  formatHuman,
  formatJson,
  useColor,
  type Check,
  type CheckGroup,
} from "../src/cli/doctor-framework.ts";

function pass(id: string, group: CheckGroup = "Runtime"): Check {
  return { id, group, run: async () => ({ result: "pass", detail: "ok" }) };
}

function fail(id: string, group: CheckGroup = "Runtime"): Check {
  return { id, group, run: async () => ({ result: "fail", detail: "broke", fixHint: "fix it" }) };
}

function warn(id: string, group: CheckGroup = "Runtime"): Check {
  return { id, group, run: async () => ({ result: "warn", detail: "meh" }) };
}

describe("doctor framework exit matrix", () => {
  test("all pass exits 0", async () => {
    const results = await collectResults([pass("a"), pass("b")]);
    expect(computeExitCode(results)).toBe(0);
  });

  test("warn never fails: exits 0", async () => {
    const results = await collectResults([pass("a"), warn("b")]);
    expect(computeExitCode(results)).toBe(0);
  });

  test("any fail exits 1", async () => {
    const results = await collectResults([pass("a"), fail("b"), warn("c")]);
    expect(computeExitCode(results)).toBe(1);
  });
});

describe("doctor framework isolation", () => {
  test("crashing check yields fail, not throw", async () => {
    const crashing: Check = {
      id: "boom",
      group: "Runtime",
      run: async () => {
        throw new Error("kaboom");
      },
    };
    const results = await collectResults([crashing, pass("after")]);
    expect(results).toHaveLength(2);
    expect(results[0]?.result).toBe("fail");
    expect(results[0]?.detail).toContain("kaboom");
    expect(results[1]?.result).toBe("pass");
    expect(computeExitCode(results)).toBe(1);
  });
});

describe("doctor framework json + redaction", () => {
  test("--json parses with secret redaction", async () => {
    const secret: Check = {
      id: "cfg",
      group: "Config",
      run: async () => ({ result: "pass", detail: "MY_API_KEY=abc123 TOKEN=xyz SUB_URL=https://x" }),
    };
    const results = await collectResults([secret]);
    const json = formatJson(results, "0.1.0", "win32");
    const parsed = JSON.parse(json) as {
      ok: boolean;
      version: string;
      platform: string;
      checks: Array<{ id: string; detail?: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toBe("0.1.0");
    expect(parsed.checks).toHaveLength(1);
    const detail = parsed.checks[0]?.detail ?? "";
    expect(detail).not.toContain("abc123");
    expect(detail).toContain("[redacted]");
  });

  test("human format uses symbols, NO_COLOR strips them", async () => {
    const results = await collectResults([pass("a"), fail("b"), warn("c")]);
    const colored = formatHuman(results, { color: true, verbose: false });
    expect(colored).toContain("[✓]");
    expect(colored).toContain("[✗]");
    expect(colored).toContain("[!]");
    expect(useColor({ NO_COLOR: "1" })).toBe(false);
    expect(useColor({})).toBe(true);
    const plain = formatHuman(results, { color: useColor({ NO_COLOR: "1" }), verbose: false });
    expect(plain).not.toContain("✓");
    expect(plain).not.toContain("✗]");
    expect(plain).toContain("[pass]");
    expect(plain).toContain("[fail]");
    expect(plain).toContain("[warn]");
  });
});
