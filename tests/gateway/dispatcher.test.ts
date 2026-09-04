import { afterEach, describe, expect, test } from "bun:test";
import { getGlobalDispatcher } from "undici";
import ProxyAgent from "undici/lib/dispatcher/proxy-agent.js";
import Socks5ProxyAgent from "undici/lib/dispatcher/socks5-proxy-agent.js";
import {
  agentFor,
  BODY_TIMEOUT_MS,
  closeDispatchers,
  currentDispatcher,
  HEADERS_TIMEOUT_MS,
  parseEgressUpstreams,
} from "@/gateway/dispatcher";

afterEach(() => {
  delete process.env["EGRESS_UPSTREAMS"];
  void closeDispatchers();
});

describe("parseEgressUpstreams", () => {
  test("empty env means direct (no egress list)", () => {
    expect(parseEgressUpstreams({})).toEqual([]);
  });

  test("splits comma-separated list", () => {
    expect(
      parseEgressUpstreams({
        EGRESS_UPSTREAMS: "socks5://127.0.0.1:1081, socks5://127.0.0.1:1082",
      }),
    ).toEqual(["socks5://127.0.0.1:1081", "socks5://127.0.0.1:1082"]);
  });
});

describe("agentFor", () => {
  test("socks5 scheme -> Socks5ProxyAgent", () => {
    expect(agentFor("socks5://127.0.0.1:1090")).toBeInstanceOf(Socks5ProxyAgent);
  });

  test("http scheme -> ProxyAgent", () => {
    expect(agentFor("http://127.0.0.1:8080")).toBeInstanceOf(ProxyAgent);
  });

  test("agents are cached per egress url", () => {
    const first = agentFor("socks5://127.0.0.1:1090");
    expect(agentFor("socks5://127.0.0.1:1090")).toBe(first);
  });
});

describe("currentDispatcher", () => {
  test("no env -> undefined (direct, global dispatcher untouched)", () => {
    expect(currentDispatcher()).toBeUndefined();
    const cached = agentFor("socks5://127.0.0.1:1090");
    expect(getGlobalDispatcher()).not.toBe(cached);
  });

  test("EGRESS_UPSTREAMS single egress -> that agent", () => {
    process.env["EGRESS_UPSTREAMS"] = "socks5://127.0.0.1:1090";
    expect(currentDispatcher()).toBe(agentFor("socks5://127.0.0.1:1090"));
  });
});

describe("timeouts", () => {
  test("headersTimeout is 15s and streams get 30s+ body budget", () => {
    expect(HEADERS_TIMEOUT_MS).toBe(15_000);
    expect(BODY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
