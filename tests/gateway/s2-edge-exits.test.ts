import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAddProxy } from "@/cli/commands/add-proxy";
import { NO_EGRESS_MESSAGE } from "@/gateway/egress-gate";
import { startServe } from "@/gateway/serve-boot";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("S2 edge exits", () => {
  let errors: string[] = [];
  const origError: (...args: unknown[]) => void = console.error;

  beforeEach(() => {
    errors = [];
    console.error = (...args: unknown[]): void => {
      errors.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.error = origError;
  });

  test("serve with empty EGRESS_UPSTREAMS exits 1 and prints NO_EGRESS_MESSAGE", async () => {
    const saved: string | undefined = process.env["EGRESS_UPSTREAMS"];
    process.env["EGRESS_UPSTREAMS"] = "";
    try {
      const code: number = await startServe([]);
      expect(code).toBe(1);
      expect(errors.join("\n")).toContain(NO_EGRESS_MESSAGE);
    } finally {
      if (saved === undefined) {
        delete process.env["EGRESS_UPSTREAMS"];
      } else {
        process.env["EGRESS_UPSTREAMS"] = saved;
      }
    }
  });

  test("add-proxy with bad URL exits 2 and leaves .env byte-identical", async () => {
    const dir: string = mkdtempSync(join(tmpdir(), "zen-s2-edge-"));
    const envPath: string = join(dir, ".env");
    const initial: string = "PORT=20128\nEGRESS_UPSTREAMS=\n";
    writeFileSync(envPath, initial, "utf8");
    const beforeHash: string = sha256Hex(readFileSync(envPath, "utf8"));
    const code: number = await runAddProxy(["not-a-url"], { envPath });
    expect(code).toBe(2);
    const after: string = readFileSync(envPath, "utf8");
    expect(sha256Hex(after)).toBe(beforeHash);
    expect(after).toBe(initial);
  });
});
