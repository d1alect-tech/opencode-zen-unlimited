import { describe, expect, test } from "bun:test";
import { convertSubContent } from "../../src/sub-converter/index.ts";
import { fetchSub, validateSubUrl } from "../../src/sub-converter/fetch.ts";

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

  test("clash selector groups + nested name lists are skipped, server nodes convert", () => {
    const raw = [
      "proxies:",
      "  - name: Fastest",
      "    type: url-test",
      "    proxies:",
      "      - n1",
      "  - name: n1",
      "    type: ss",
      "    server: example.com",
      "    port: 8388",
      "    cipher: aes-256-gcm",
      "    password: fake-pass",
    ].join("\n");
    const res = convertSubContent(raw, {});
    expect(res.outbounds.length).toBe(1);
    expect(res.relayUpstreams[0]).toMatchObject({ server: "example.com", port: 8388 });
  });

  test("clash vless reality+xhttp keeps reality/utls/transport in the outbound", () => {
    const raw = [
      "proxies:",
      "  - name: n1",
      "    type: vless",
      "    server: example.com",
      "    port: 443",
      "    network: xhttp",
      "    udp: true",
      "    uuid: 11111111-2222-3333-4444-555555555555",
      "    tls: true",
      "    servername: example.com",
      "    reality-opts:",
      "      public-key: PUBKEY",
      "      short-id: SHORTID",
      "    xhttp-opts:",
      "      path: /xhttp",
      "      mode: stream-up",
      "    client-fingerprint: chrome",
    ].join("\n");
    const res = convertSubContent(raw, {});
    expect(res.outbounds.length).toBe(1);
    const ob = res.outbounds[0] as unknown as Record<string, unknown>;
    const tls = ob["tls"] as Record<string, unknown>;
    expect(tls["reality"]).toEqual({ enabled: true, public_key: "PUBKEY", short_id: "SHORTID" });
    expect(tls["utls"]).toEqual({ enabled: true, fingerprint: "chrome" });
    expect(ob["transport"]).toEqual({ type: "xhttp", path: "/xhttp", mode: "stream-up" });
  });

  test("clash groups-only subscription fails with selector hint, not phantom record", () => {
    const raw = ["proxies:", "  - name: Fastest", "    type: url-test", "    proxies:", "      - n1"].join("\n");
    expect(() => convertSubContent(raw, {})).toThrow(/selector groups/i);
  });

  test("clash nested proxies: inside proxy-groups does not hijack the top-level section", () => {
    const raw = [
      "proxy-groups:",
      "  - name: Fastest",
      "    type: url-test",
      "    proxies:",
      "      - n1",
      "proxies:",
      "  - name: n1",
      "    type: ss",
      "    server: example.com",
      "    port: 8388",
      "    cipher: aes-256-gcm",
      "    password: fake-pass",
    ].join("\n");
    const res = convertSubContent(raw, {});
    expect(res.outbounds.length).toBe(1);
    expect(res.relayUpstreams[0]).toMatchObject({ server: "example.com", port: 8388 });
  });

  test("SSRF guard rejects localhost/metadata/http-only", () => {
    expect(() => validateSubUrl("ftp://example.com/sub")).toThrow(/http/i);
    expect(() => validateSubUrl("http://127.0.0.1/sub")).toThrow(/blocked/i);
    expect(() => validateSubUrl("http://localhost/sub")).toThrow(/blocked/i);
    expect(() => validateSubUrl("http://169.254.169.254/latest")).toThrow(/blocked/i);
    expect(validateSubUrl("https://example.com/sub").hostname).toBe("example.com");
  });

  test("redirect to loopback is rejected per-hop", async () => {
    const fetchImpl = (async (u: string) => {
      if (u === "https://example.com/sub") {
        return new Response("", { status: 302, headers: { location: "http://127.0.0.1/evil" } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    await expect(fetchSub("https://example.com/sub", { fetchImpl })).rejects.toThrow(/blocked/i);
  });

  test("redirect to public https is followed", async () => {
    const fetchImpl = (async (u: string) => {
      if (u === "https://example.com/sub") {
        return new Response("", { status: 302, headers: { location: "https://cdn.example.com/sub2" } });
      }
      if (u === "https://cdn.example.com/sub2") return new Response("ok-body", { status: 200 });
      throw new Error(`unexpected fetch: ${u}`);
    }) as typeof fetch;
    await expect(fetchSub("https://example.com/sub", { fetchImpl })).resolves.toBe("ok-body");
  });
});
