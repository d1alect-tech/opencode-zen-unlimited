import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnDetached } from "../src/process/spawn.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zen-spawn-"));
}

describe("spawnDetached", () => {
  test("spawns, redirects output to log file, returns pid", async () => {
    const dir = tmp();
    const logDir = mkdtempSync(join(tmpdir(), "zen-spawn-log-"));
    // Fake proc: node inline that prints then exits. No real sing-box/relay.
    const pid = spawnDetached(process.execPath, ["-e", "console.log('hello-spawn')"], {
      name: "fake",
      logDir,
      pidDir: dir,
    });
    expect(pid).toBeGreaterThan(0);
    // Give the child a moment to flush stdout to the log file.
    for (let i = 0; i < 50; i++) {
      const content = existsSync(join(logDir, "fake.log"))
        ? readFileSync(join(logDir, "fake.log"), "utf8")
        : "";
      if (content.includes("hello-spawn")) break;
      await Bun.sleep(50);
    }
    expect(readFileSync(join(logDir, "fake.log"), "utf8")).toContain("hello-spawn");
    expect(readFileSync(join(dir, "fake.pid"), "utf8").trim()).toBe(String(pid));
  });
});
