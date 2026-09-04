import { describe, expect, test } from "bun:test";
import { detectFormat, splitLines } from "../../src/sub-converter/detect.ts";

const VLESS = "vless://uuid-1234@example.com:443?encryption=none&security=tls&sni=example.com#node1";

describe("detect() branches on content", () => {
  test("raw single URI detected as uri-list", () => {
    expect(detectFormat(VLESS)).toBe("uri-list");
  });

  test("multiline raw URI list detected as uri-list", () => {
    const raw = [VLESS, "trojan://pass@example.com:443?sni=example.com#t2"].join("\n");
    expect(detectFormat(raw)).toBe("uri-list");
  });

  test("base64 blob of URIs detected as base64-uri", () => {
    const blob = Buffer.from([VLESS, "trojan://pass@example.com:443#t2"].join("\n")).toString("base64");
    expect(detectFormat(blob)).toBe("base64-uri");
  });

  test("clash yaml with proxies: detected as clash-yaml", () => {
    const yaml = "port: 7890\nproxies:\n  - name: n1\n    type: ss\n    server: example.com\n    port: 8388\n";
    expect(detectFormat(yaml)).toBe("clash-yaml");
  });

  test("sing-box json config detected as json", () => {
    const json = JSON.stringify({ outbounds: [{ type: "vless", tag: "x", server: "example.com", server_port: 443 }] });
    expect(detectFormat(json)).toBe("json");
  });

  test("splitLines drops blanks and comments", () => {
    const lines = splitLines("// comment\n\nvless://a@b:1\n");
    expect(lines).toEqual(["vless://a@b:1"]);
  });
});
