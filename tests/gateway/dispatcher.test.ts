import { afterEach, describe, expect, test } from "bun:test";
import { SocksProxyAgent } from "socks-proxy-agent";
import {
  agentFor,
  closeDispatchers,
  currentDispatcher,
  parseEgressUpstreams,
} from "@/gateway/dispatcher";

afterEach(() => {
  delete process.env["EGRESS_UPSTREAMS"];
  closeDispatchers();
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
  test("socks5 scheme -> SocksProxyAgent", () => {
    expect(agentFor("socks5://127.0.0.1:1090")).toBeInstanceOf(SocksProxyAgent);
  });

  test("socks5h scheme -> SocksProxyAgent (normalized)", () => {
    expect(agentFor("socks5h://127.0.0.1:1090")).toBeInstanceOf(
      SocksProxyAgent,
    );
  });

  test("agents are cached per egress url", () => {
    const first = agentFor("socks5://127.0.0.1:1090");
    expect(agentFor("socks5://127.0.0.1:1090")).toBe(first);
  });

  test("socks5h and socks5 spellings of one endpoint share one agent", () => {
    const first = agentFor("socks5h://127.0.0.1:1091");
    expect(agentFor("socks5://127.0.0.1:1091")).toBe(first);
  });

  test("non-proxy scheme throws a usage error", () => {
    expect(() => agentFor("vless://user@example.com:443")).toThrow(
      /SOCKS proxy URL/,
    );
  });
});

describe("currentDispatcher", () => {
  test("no env -> undefined (direct)", () => {
    expect(currentDispatcher()).toBeUndefined();
  });

  test("EGRESS_UPSTREAMS single egress -> that agent", () => {
    process.env["EGRESS_UPSTREAMS"] = "socks5://127.0.0.1:1090";
    expect(currentDispatcher()).toBe(agentFor("socks5://127.0.0.1:1090"));
  });
});
