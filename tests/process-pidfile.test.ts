import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, readPid, removePid, resolvePidDir, writePid } from "../src/process/pidfile.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zen-pid-"));
}

describe("pidfile stale handling", () => {
  test("stale pid treated as free (readPid returns null)", () => {
    const dir = tmp();
    // PID 2^30 almost certainly does not exist.
    const deadPid = 1073741824;
    writeFileSync(join(dir, "relay.pid"), `${deadPid}\n`, "utf8");
    expect(isAlive(deadPid)).toBe(false);
    expect(readPid(dir, "relay")).toBeNull();
  });

  test("live pid round-trips", () => {
    const dir = tmp();
    writePid(dir, "relay", process.pid);
    expect(readPid(dir, "relay")).toBe(process.pid);
    expect(isAlive(process.pid)).toBe(true);
  });

  test("EPERM means alive-but-unowned: pid 4 stays, pidfile kept", () => {
    // PID 4 (System) exists on every Windows box but is never signalable
    // from user space: process.kill(pid, 0) throws EPERM, not ESRCH.
    // That must count as alive — deleting the pidfile here is what made
    // `zen status` report dead for healthy SYSTEM-stack processes.
    expect(isAlive(4)).toBe(true);
    const dir = tmp();
    writePid(dir, "gateway", 4);
    expect(readPid(dir, "gateway")).toBe(4);
  });

  test("garbage content treated as free", () => {
    const dir = tmp();
    writeFileSync(join(dir, "relay.pid"), "not-a-pid\n", "utf8");
    expect(readPid(dir, "relay")).toBeNull();
  });

  test("removePid missing file no-throw", () => {
    removePid(tmp(), "nope");
  });

  test("resolvePidDir honors explicit dir", () => {
    expect(resolvePidDir("/tmp/x")).toBe("/tmp/x");
  });
});
