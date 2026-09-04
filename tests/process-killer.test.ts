import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killPid } from "../src/process/killer.ts";

describe("killer missing PID", () => {
  test("kill missing PID no-throw", async () => {
    // 2^30: no such process on any sane machine.
    await killPid(1073741824);
  });

  test("kill invalid PID no-throw", async () => {
    await killPid(-1);
    await killPid(0);
    await killPid(Number.NaN);
  });

  test("killPid resolves void", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zen-kill-"));
    void dir;
    const r: void = await killPid(1073741823);
    expect(r).toBeUndefined();
  });
});
