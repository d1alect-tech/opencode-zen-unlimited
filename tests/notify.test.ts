import { describe, expect, test } from "bun:test";
import { notifyCrash, type CrashPayload } from "../src/process/notify.ts";

describe("notifyCrash", () => {
  test("fake notifier receives proc and lines", () => {
    const seen: CrashPayload[] = [];
    notifyCrash("gateway", ["boom line 1", "boom line 2"], {
      notifier: (p) => {
        seen.push(p);
      },
    });
    expect(seen).toHaveLength(1);
    const payload = seen[0] as CrashPayload;
    expect(payload.proc).toBe("gateway");
    expect(payload.lines).toEqual(["boom line 1", "boom line 2"]);
  });

  test("quiet suppresses the call", () => {
    let calls = 0;
    notifyCrash("relay", ["x"], {
      quiet: true,
      notifier: () => {
        calls += 1;
      },
    });
    expect(calls).toBe(0);
  });

  test("missing notifier module does not throw (silent no-op in CI)", () => {
    // node-notifier is NOT installed in CI; default path must be silent.
    expect(() => notifyCrash("gateway", ["tail line"])).not.toThrow();
    expect(() => notifyCrash("relay", [], { quiet: false })).not.toThrow();
  });
});
