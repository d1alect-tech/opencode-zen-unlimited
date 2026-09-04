import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, logPath, resolveLogDir, rotateLog, tailLog } from "../src/process/logs.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zen-log-"));
}

describe("logs rotate + tail", () => {
  test("5MB rotate keeps x5 generations", () => {
    const dir = tmp();
    writeFileSync(join(dir, "relay.log"), "x".repeat(6 * 1024 * 1024), "utf8");
    writeFileSync(join(dir, "relay.log.1"), "old1", "utf8");
    writeFileSync(join(dir, "relay.log.4"), "old4", "utf8");
    rotateLog(dir, "relay");
    const files = readdirSync(dir).filter((f) => f.startsWith("relay.log")).sort();
    // relay.log (fresh) + .1..5, .6+ evicted
    expect(files).toContain("relay.log.1");
    expect(files).toContain("relay.log.5");
    expect(files.includes("relay.log.6")).toBe(false);
    expect(readFileSync(join(dir, "relay.log"), "utf8")).toBe("");
  });

  test("no rotate under 5MB", () => {
    const dir = tmp();
    writeFileSync(join(dir, "relay.log"), "small", "utf8");
    rotateLog(dir, "relay");
    expect(readdirSync(dir).sort()).toEqual(["relay.log"]);
  });

  test("tail returns last N lines", () => {
    const dir = tmp();
    appendLog(dir, "relay", "line1");
    appendLog(dir, "relay", "line2");
    appendLog(dir, "relay", "line3");
    const tail = tailLog(dir, "relay", 2);
    expect(tail).toEqual(["line2", "line3"]);
  });

  test("tail missing file returns empty", () => {
    expect(tailLog(tmp(), "nope", 10)).toEqual([]);
  });

  test("logPath + resolveLogDir helpers", () => {
    expect(logPath("/tmp/z", "relay")).toBe(join("/tmp/z", "relay.log"));
    expect(typeof resolveLogDir()).toBe("string");
    expect(typeof resolveLogDir("/tmp/z")).toBe("string");
  });
});
