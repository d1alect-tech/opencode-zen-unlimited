import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog } from "../src/process/logs.ts";
import { runLogs } from "../src/cli/commands/logs.ts";
import { parseCliArgs } from "../src/cli/parser.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zen-logs-cmd-"));
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

describe("zen logs command", () => {
  test("parser passes --tail/--follow through for logs", () => {
    const parsed = parseCliArgs(["logs", "gateway", "--tail", "5"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.subcommand !== undefined) {
      expect(parsed.subcommand).toBe("logs");
      expect(parsed.rest).toContain("gateway");
      expect(parsed.rest).toContain("--tail");
      expect(parsed.rest).toContain("5");
    }
    const parsed2 = parseCliArgs(["logs", "relay", "--follow"]);
    expect(parsed2.ok).toBe(true);
    if (parsed2.ok) expect(parsed2.rest).toContain("--follow");
  });

  test("tail returns last N lines", async () => {
    const dir = tmp();
    for (const line of ["a", "b", "c", "d"]) appendLog(dir, "gateway", line);
    const r = await capture(() => runLogs(["gateway", "--tail", "2"], { logDir: dir }));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual(["c", "d"]);
  });

  test("default tail is 50", async () => {
    const dir = tmp();
    for (let i = 0; i < 60; i++) appendLog(dir, "relay", `line${i}`);
    const r = await capture(() => runLogs(["relay"], { logDir: dir }));
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line10");
    expect(lines[49]).toBe("line59");
  });

  test("unknown proc exits 2 with usage", async () => {
    const r = await capture(() => runLogs(["bogus"], { logDir: tmp() }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/i);
  });

  test("missing proc exits 2 with usage", async () => {
    const r = await capture(() => runLogs([], { logDir: tmp() }));
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/usage/i);
  });

  test("--follow streams mock generator (take 3 then break)", async () => {
    const dir = tmp();
    appendLog(dir, "singbox", "old");
    async function* mock(): AsyncGenerator<string, void, void> {
      yield "f1";
      yield "f2";
      yield "f3";
    }
    const r = await capture(() => runLogs(["singbox", "--follow"], { logDir: dir, followImpl: mock }));
    expect(r.code).toBe(0);
    expect(r.out.split("\n")).toEqual(["old", "f1", "f2", "f3"]);
  });
});
