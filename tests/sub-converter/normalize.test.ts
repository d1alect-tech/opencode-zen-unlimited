import { describe, expect, test } from "bun:test";
import type { NormalizedNode } from "../../src/sub-converter/types.ts";
import { assignTags, dedupNodes, filterNodes, normalizeNode } from "../../src/sub-converter/normalize.ts";

const mk = (over: Partial<NormalizedNode>): NormalizedNode => ({
  proto: "vless",
  server: "example.com",
  server_port: 443,
  ...over,
});

describe("normalize", () => {
  test("strips brackets from ipv6/host", () => {
    const n = normalizeNode(mk({ server: "[example.com]" }));
    expect(n.server).toBe("example.com");
  });

  test("hy2 defaults alpn h3 when absent", () => {
    const n = normalizeNode(mk({ proto: "hysteria2", tls: { enabled: true } }));
    expect(n.tls?.alpn).toEqual(["h3"]);
  });

  test("filter includes protos and excludes keywords", () => {
    const nodes = [mk({ proto: "vless" }), mk({ proto: "ss" })];
    const kept = filterNodes(nodes, { includeProtos: ["vless"], excludeKeywords: [] });
    expect(kept.map((n) => n.proto)).toEqual(["vless"]);
    const excluded = filterNodes([mk({ rawTag: "Expire-Test" })], { excludeKeywords: ["expire"] });
    expect(excluded).toEqual([]);
  });

  test("dedup by host+port keeps first", () => {
    const a = mk({ proto: "vless", server: "example.com", server_port: 443 });
    const b = mk({ proto: "trojan", server: "EXAMPLE.com", server_port: 443 });
    expect(dedupNodes([a, b])).toHaveLength(1);
  });

  test("stable tags proto-host-port with collision suffix", () => {
    const a = mk({ proto: "vless", server: "example.com", server_port: 443 });
    const b = mk({ proto: "vless", server: "example.com", server_port: 443 });
    const c = mk({ proto: "trojan", server: "example.com", server_port: 443 });
    const tags = assignTags([a, b, c]);
    expect(tags[0]).toBe("vless-example.com-443");
    expect(tags[1]).toBe("vless-example.com-443-2");
    expect(tags[2]).toBe("trojan-example.com-443");
  });
});
