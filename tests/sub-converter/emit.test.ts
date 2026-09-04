import { describe, expect, test } from "bun:test";
import { nodeToOutbound } from "../../src/sub-converter/emit.ts";
import type { NormalizedNode } from "../../src/sub-converter/types.ts";

describe("emit: outbound dicts carry required keys", () => {
  test("vless outbound has type/server/server_port/uuid/tls", () => {
    const ob = nodeToOutbound({ proto: "vless", server: "example.com", server_port: 443, uuid: "u", tls: { enabled: true, server_name: "example.com" } } as NormalizedNode, "vless-example.com-443");
    expect(ob).toMatchObject({ type: "vless", server: "example.com", server_port: 443, tag: "vless-example.com-443" });
    expect(ob).toHaveProperty("uuid");
    expect(ob).toHaveProperty("tls");
  });

  test("vmess outbound has uuid/security", () => {
    const ob = nodeToOutbound({ proto: "vmess", server: "example.com", server_port: 8443, uuid: "u", security: "auto" } as NormalizedNode, "t");
    expect(ob).toMatchObject({ type: "vmess", server_port: 8443 });
    expect(ob).toHaveProperty("uuid");
  });

  test("trojan outbound has password/tls", () => {
    const ob = nodeToOutbound({ proto: "trojan", server: "example.com", server_port: 443, password: "p", tls: { enabled: true } } as NormalizedNode, "t");
    expect(ob).toMatchObject({ type: "trojan", password: "p" });
    expect(ob).toHaveProperty("tls");
  });

  test("ss outbound uses shadowsocks type with method/password", () => {
    const ob = nodeToOutbound({ proto: "ss", server: "example.com", server_port: 8388, method: "aes-256-gcm", password: "p" } as NormalizedNode, "t");
    expect(ob).toMatchObject({ type: "shadowsocks", method: "aes-256-gcm", password: "p" });
  });

  test("hysteria2 outbound has password/tls.alpn h3", () => {
    const ob = nodeToOutbound({ proto: "hysteria2", server: "example.com", server_port: 443, password: "p", tls: { enabled: true, alpn: ["h3"] } } as NormalizedNode, "t");
    expect(ob).toMatchObject({ type: "hysteria2", password: "p" });
    expect((ob as unknown as Record<string, unknown> & { tls: { alpn: string[] } }).tls.alpn).toEqual(["h3"]);
  });

  test("vless reality+xhttp node emits tls.reality/utls and xhttp transport", () => {
    const node = {
      proto: "vless",
      server: "example.com",
      server_port: 443,
      uuid: "u",
      tls: {
        enabled: true,
        server_name: "example.com",
        fingerprint: "chrome",
        reality: { public_key: "pub", short_id: "sid" },
      },
      transport: { type: "xhttp", path: "/xhttp", mode: "stream-up" },
    } as NormalizedNode;
    const ob = nodeToOutbound(node, "t") as unknown as Record<string, unknown>;
    expect((ob["tls"] as Record<string, unknown>)["reality"]).toEqual({ enabled: true, public_key: "pub", short_id: "sid" });
    expect((ob["tls"] as Record<string, unknown>)["utls"]).toEqual({ enabled: true, fingerprint: "chrome" });
    expect(ob["transport"]).toEqual({ type: "xhttp", path: "/xhttp", mode: "stream-up" });
  });

  test("hysteria2 omits utls (unsupported at runtime on sing-box v1.14)", () => {
    const ob = nodeToOutbound({ proto: "hysteria2", server: "example.com", server_port: 443, password: "p", tls: { enabled: true, alpn: ["h3"], fingerprint: "chrome" } } as NormalizedNode, "t") as unknown as Record<string, unknown>;
    expect((ob["tls"] as Record<string, unknown>)["utls"]).toBeUndefined();
    expect((ob["tls"] as Record<string, unknown>)["fingerprint"]).toBeUndefined();
  });
});
