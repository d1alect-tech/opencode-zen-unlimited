import { describe, expect, test } from "bun:test";
import { parseUri } from "../../src/sub-converter/parsers/index.ts";

describe("parsers: one fixture per proto", () => {
  test("vless:// produces vless outbound fields", () => {
    const n = parseUri("vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com&flow=xtls-rprx-vision#vless-node");
    expect(n.proto).toBe("vless");
    expect(n.server).toBe("example.com");
    expect(n.server_port).toBe(443);
    expect(n.uuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(n.tls?.enabled).toBe(true);
    expect(n.tls?.server_name).toBe("example.com");
  });

  test("vmess:// base64 json produces vmess fields", () => {
    const json = JSON.stringify({ v: "2", ps: "vm", add: "example.com", port: "8443", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", aid: "0", scy: "auto", net: "tcp", tls: "tls", sni: "example.com" });
    const uri = `vmess://${Buffer.from(json).toString("base64")}#vm-node`;
    const n = parseUri(uri);
    expect(n.proto).toBe("vmess");
    expect(n.server).toBe("example.com");
    expect(n.server_port).toBe(8443);
    expect(n.uuid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(n.tls?.enabled).toBe(true);
  });

  test("trojan:// produces trojan fields", () => {
    const n = parseUri("trojan://fake-password@example.com:443?sni=example.com#trojan-node");
    expect(n.proto).toBe("trojan");
    expect(n.server).toBe("example.com");
    expect(n.server_port).toBe(443);
    expect(n.password).toBe("fake-password");
    expect(n.tls?.enabled).toBe(true);
    expect(n.tls?.server_name).toBe("example.com");
  });

  test("ss:// sip002 produces shadowsocks fields", () => {
    const userinfo = Buffer.from("aes-256-gcm:fake-password").toString("base64url");
    const n = parseUri(`ss://${userinfo}@example.com:8388#ss-node`);
    expect(n.proto).toBe("ss");
    expect(n.server).toBe("example.com");
    expect(n.server_port).toBe(8388);
    expect(n.method).toBe("aes-256-gcm");
    expect(n.password).toBe("fake-password");
  });

  test("ss:// legacy full-base64 produces shadowsocks fields", () => {
    const full = Buffer.from("aes-128-gcm:fake-pass@example.com:8388").toString("base64");
    const n = parseUri(`ss://${full}#legacy`);
    expect(n.proto).toBe("ss");
    expect(n.server).toBe("example.com");
    expect(n.password).toBe("fake-pass");
  });

  test("hysteria2:// produces hy2 fields with alpn h3 default", () => {
    const n = parseUri("hysteria2://fake-pass@example.com:443?sni=example.com#hy2-node");
    expect(n.proto).toBe("hysteria2");
    expect(n.server).toBe("example.com");
    expect(n.server_port).toBe(443);
    expect(n.password).toBe("fake-pass");
    expect(n.tls?.enabled).toBe(true);
    expect(n.tls?.alpn).toEqual(["h3"]);
  });

  test("ssr:// rejected with clear error", () => {
    expect(() => parseUri("ssr://example.com:8388:origin:rc4:plain:fake/?obfsparam=&remarks=xyz")).toThrow(/ssr.*not supported/i);
  });

  test("unknown scheme rejected", () => {
    expect(() => parseUri("tuic://example.com:443")).toThrow(/unsupported scheme/i);
  });

  test("vless:// reality+xhttp params produce reality/fingerprint/transport", () => {
    const n = parseUri("vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=reality&sni=example.com&fp=chrome&pbk=PUBKEY&sid=SHORTID&type=xhttp&path=%2Fxhttp&mode=stream-up#reality-node");
    expect(n.proto).toBe("vless");
    expect(n.tls?.enabled).toBe(true);
    expect(n.tls?.fingerprint).toBe("chrome");
    expect(n.tls?.reality).toEqual({ public_key: "PUBKEY", short_id: "SHORTID" });
    expect(n.transport).toEqual({ type: "xhttp", path: "/xhttp", mode: "stream-up" });
  });
});
