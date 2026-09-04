import { describe, expect, test } from "bun:test";
import { convertSubContent } from "../../src/sub-converter/index.ts";
import { validateSubUrl } from "../../src/sub-converter/fetch.ts";

describe("pipeline: sub content to singbox.json + relay_upstreams.json", () => {
  test("mixed uri list converts, dedups, merges template {all}", () => {
    const raw = [
      "vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com#n1",
      "vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com#n1-dup",
      "trojan://fake-pass@example.com:8443?sni=example.com#n2",
      "ssr://example.com:8388:origin:rc4:plain:fake#bad",
    ].join("\n");
    const template = {
      outbounds: [
        { type: "selector", tag: "select", outbounds: ["{all}", "direct"] },
        { type: "urltest", tag: "auto", outbounds: ["{all}"], url: "https://www.gstatic.com/generate_204", interval: "1m", tolerance: 50 },
      ],
      route: { final: "{all-first}" },
    };
    const res = convertSubContent(raw, {}, template);
    expect(res.errors.join(";")).toMatch(/ssr/i);
    expect(res.outbounds.length).toBe(2);
    const sel = res.singboxConfig.outbounds.find((o: { tag?: string }) => o.tag === "select") as unknown as { outbounds: string[] };
    expect(sel.outbounds).toContain("vless-example.com-443");
    expect(sel.outbounds).toContain("trojan-example.com-8443");
    expect(sel.outbounds).not.toContain("{all}");
    expect(res.relayUpstreams[0]).toMatchObject({ server: "example.com", port: 443 });
    expect(res.relayUpstreams[1]).toMatchObject({ server: "example.com", port: 8443 });
    expect(res.relayUpstreams[0]).toHaveProperty("tag");
    expect(res.relayUpstreams[0]).toHaveProperty("proto");
  });

  test("zero valid nodes fails loud", () => {
    expect(() => convertSubContent("ssr://example.com:1#x", {})).toThrow(/no valid nodes/i);
  });

  test("SSRF guard rejects localhost/metadata/http-only", () => {
    expect(() => validateSubUrl("ftp://example.com/sub")).toThrow(/http/i);
    expect(() => validateSubUrl("http://127.0.0.1/sub")).toThrow(/blocked/i);
    expect(() => validateSubUrl("http://localhost/sub")).toThrow(/blocked/i);
    expect(() => validateSubUrl("http://169.254.169.254/latest")).toThrow(/blocked/i);
    expect(validateSubUrl("https://example.com/sub").hostname).toBe("example.com");
  });
});
