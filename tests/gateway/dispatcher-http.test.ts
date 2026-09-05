import { afterEach, describe, expect, test } from "bun:test";
import { SocksProxyAgent } from "socks-proxy-agent";
import {
  agentFor,
  closeDispatchers,
  PROXY_SCHEMES,
} from "@/gateway/dispatcher";
import { HttpProxyAgent } from "@/gateway/http-proxy-agent";

afterEach(() => {
  closeDispatchers();
});

describe("agentFor http/https egress (purchased proxies)", () => {
  test("http scheme -> HttpProxyAgent", () => {
    expect(agentFor("http://127.0.0.1:8080")).toBeInstanceOf(HttpProxyAgent);
  });

  test("https scheme -> HttpProxyAgent", () => {
    expect(agentFor("https://127.0.0.1:8443")).toBeInstanceOf(HttpProxyAgent);
  });

  test("http URL with auth accepted", () => {
    expect(agentFor("http://user:pass@127.0.0.1:8080")).toBeInstanceOf(
      HttpProxyAgent,
    );
  });

  test("http URL without auth accepted", () => {
    expect(agentFor("http://127.0.0.1:8080")).toBeInstanceOf(HttpProxyAgent);
  });

  test("http agents are cached per egress url", () => {
    const first = agentFor("http://127.0.0.1:8080");
    expect(agentFor("http://127.0.0.1:8080")).toBe(first);
  });

  test("http and https spellings of one endpoint are distinct agents", () => {
    const plain = agentFor("http://127.0.0.1:8080");
    const secure = agentFor("https://127.0.0.1:8080");
    expect(plain).toBeInstanceOf(HttpProxyAgent);
    expect(secure).toBeInstanceOf(HttpProxyAgent);
    expect(secure).not.toBe(plain);
  });

  test("socks5 scheme still -> SocksProxyAgent (path unchanged)", () => {
    expect(agentFor("socks5://127.0.0.1:1090")).toBeInstanceOf(SocksProxyAgent);
  });

  test("socks5h still normalized and shared with socks5", () => {
    const first = agentFor("socks5h://127.0.0.1:1092");
    expect(agentFor("socks5://127.0.0.1:1092")).toBe(first);
  });

  test("non-proxy scheme (vless:) rejected with usage error", () => {
    expect(() => agentFor("vless://user@example.com:443")).toThrow(
      /SOCKS proxy URL/,
    );
  });

  test("invalid URL rejected with usage error", () => {
    expect(() => agentFor("not-a-url")).toThrow(/SOCKS proxy URL/);
  });

  test("PROXY_SCHEMES lists every accepted scheme", () => {
    for (const scheme of [
      "socks5",
      "socks",
      "socks4",
      "socks4a",
      "http",
      "https",
    ]) {
      expect(PROXY_SCHEMES.has(scheme)).toBe(true);
    }
    expect(PROXY_SCHEMES.has("vless")).toBe(false);
  });
});
