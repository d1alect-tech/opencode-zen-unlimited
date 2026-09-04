import { describe, expect, test } from "bun:test";
import {
  DIRECT_MODE_WARNING,
  evaluateEgressGate,
  NO_EGRESS_MESSAGE,
} from "@/gateway/egress-gate";

describe("no-egress boot gate (T8)", () => {
  test("empty upstreams without override -> refuse with zen setup message", () => {
    const decision = evaluateEgressGate([], []);
    expect(decision.allowed).toBe(false);
    expect(decision.direct).toBe(false);
    expect(NO_EGRESS_MESSAGE).toContain("zen setup");
    expect(NO_EGRESS_MESSAGE).toContain("zen add-sub");
    expect(NO_EGRESS_MESSAGE).toContain("--no-egress-direct");
  });

  test("empty upstreams with --no-egress-direct -> allow direct + loud warning", () => {
    const decision = evaluateEgressGate([], ["--no-egress-direct"]);
    expect(decision.allowed).toBe(true);
    expect(decision.direct).toBe(true);
    expect(DIRECT_MODE_WARNING.length).toBeGreaterThan(0);
  });

  test("configured upstreams -> allow, never direct even with flag", () => {
    const decision = evaluateEgressGate(["socks5://127.0.0.1:1090"], []);
    expect(decision.allowed).toBe(true);
    expect(decision.direct).toBe(false);
  });
});
