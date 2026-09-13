import { describe, expect, test } from "bun:test";
import { isLoopbackBase } from "@/gateway/app";
import { resolveUpstreamBase } from "@/gateway/serve-boot";

describe("upstream base seam (double-proxy via Headroom)", () => {
  test("unset/blank ZEN_UPSTREAM_BASE -> undefined (direct Zen base)", () => {
    expect(resolveUpstreamBase({})).toBeUndefined();
    expect(resolveUpstreamBase({ ZEN_UPSTREAM_BASE: "" })).toBeUndefined();
    expect(resolveUpstreamBase({ ZEN_UPSTREAM_BASE: "   " })).toBeUndefined();
  });

  test("set ZEN_UPSTREAM_BASE -> trimmed value", () => {
    expect(
      resolveUpstreamBase({ ZEN_UPSTREAM_BASE: "http://127.0.0.1:8788/v1\n" }),
    ).toBe("http://127.0.0.1:8788/v1");
  });

  test("loopback bases bypass egress", () => {
    expect(isLoopbackBase("http://127.0.0.1:8788/v1")).toBe(true);
    expect(isLoopbackBase("http://localhost:8788/v1")).toBe(true);
    expect(isLoopbackBase("http://127.0.0.2:8788/v1")).toBe(true);
  });

  test("remote bases keep egress", () => {
    expect(isLoopbackBase("https://opencode.ai/zen/v1")).toBe(false);
    expect(isLoopbackBase("not a url")).toBe(false);
  });
});
