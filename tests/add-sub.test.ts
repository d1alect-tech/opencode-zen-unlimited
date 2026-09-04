import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAddSub } from "../src/cli/commands/add-sub.ts";

const SAMPLE_SUB = [
  "vless://11111111-2222-3333-4444-555555555555@example.com:443?encryption=none&security=tls&sni=example.com#n1",
  "trojan://fake-pass@example.net:8443?sni=example.net#n2",
].join("\n");

function stubFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("zen add-sub", () => {
  let dir = "";
  let configPath = "";
  let envPath = "";
  let logs: string[] = [];
  let errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zen-add-sub-"));
    mkdirSync(join(dir, "sing-box"), { recursive: true });
    configPath = join(dir, "sing-box", "config.json");
    envPath = join(dir, ".env");
    writeFileSync(configPath, JSON.stringify({ outbounds: [], route: { final: "direct" } }, null, 2), "utf8");
    writeFileSync(envPath, "PORT=20128\nEGRESS_UPSTREAMS=\n", "utf8");
    logs = [];
    errors = [];
    console.log = (...args: unknown[]): void => {
      logs.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]): void => {
      errors.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
  });

  test("ftp URL -> exit 2 with reason", async () => {
    const code = await runAddSub(["ftp://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/error:/i);
  });

  test("garbage URL -> exit 2", async () => {
    const code = await runAddSub(["not-a-url"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(2);
  });

  test("missing url -> exit 2 + usage", async () => {
    const code = await runAddSub([], { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/usage/i);
  });

  test("unknown flag -> exit 2", async () => {
    const code = await runAddSub(["https://example.com/sub", "--nope"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(2);
  });

  test("valid sub appends nodes, backups .env + config, redacts secrets", async () => {
    const code = await runAddSub(["https://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(0);
    expect(existsSync(`${envPath}.bak`)).toBe(true);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("EGRESS_SUB_URL=https://example.com/sub");
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string }>;
    };
    expect(cfg.outbounds.length).toBe(2);
    const out = logs.join("\n");
    expect(out).toMatch(/added 2 node/);
    expect(out).toMatch(/zen doctor/);
    expect(out).not.toContain("fake-pass");
    expect(out).not.toContain("11111111-2222");
  });

  test("rerun is idempotent (no dup nodes)", async () => {
    const deps = { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) };
    expect(await runAddSub(["https://example.com/sub"], deps)).toBe(0);
    logs = [];
    expect(await runAddSub(["https://example.com/sub"], deps)).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string }>;
    };
    expect(cfg.outbounds.length).toBe(2);
    expect(logs.join("\n")).toMatch(/added 0 node/);
  });

  test("malformed sub (zero valid nodes) -> exit 2 with reason", async () => {
    const code = await runAddSub(["https://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch("ssr://example.com:8388:origin:rc4:plain:fake#bad"),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/error:/i);
  });

  test("--name prefixes added tags", async () => {
    const code = await runAddSub(["https://example.com/sub", "--name", "t9"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string }>;
    };
    const tags = cfg.outbounds.map((o) => o.tag ?? "");
    expect(tags.every((t) => t.startsWith("t9-"))).toBe(true);
  });

  test("prefers the UA variant with more nodes (provider UA sniffing)", async () => {
    const preset = ["proxies:", "  - name: Fastest", "    type: url-test"].join("\n");
    const uaFetch = (async (_u: string, init?: RequestInit) => {
      const headers = init?.headers as unknown as Record<string, string> | undefined;
      const ua = headers?.["user-agent"] ?? "";
      const body = ua.includes("clash.meta") ? SAMPLE_SUB : preset;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const code = await runAddSub(["https://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: uaFetch,
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: unknown[];
    };
    expect(cfg.outbounds.length).toBe(2);
  });

  test("rewires socks routes to fresh nodes, drops dead placeholders", async () => {
    const placeholders = ["nl", "de", "fi", "pl", "se", "cz"].map((cc) => ({
      type: "hysteria2",
      tag: `${cc}-hy2`,
      server: `YOUR_HY2_SERVER_${cc.toUpperCase()}`,
      server_port: 443,
      password: "YOUR_HY2_PASSWORD",
    }));
    const templateCfg = {
      inbounds: [1081, 1082, 1083, 1084, 1085, 1086].map((port) => ({
        type: "socks",
        tag: `socks-${port}`,
        listen: "127.0.0.1",
        listen_port: port,
      })),
      outbounds: [
        ...placeholders,
        { type: "direct", tag: "direct" },
        { type: "urltest", tag: "auto", outbounds: placeholders.map((p) => p.tag) },
        { type: "selector", tag: "select", outbounds: [...placeholders.map((p) => p.tag), "auto", "direct"] },
      ],
      route: {
        final: "direct",
        rules: ["nl", "de", "fi", "pl", "se", "cz"].map((cc, i) => ({
          inbound: [`socks-${1081 + i}`],
          action: "route",
          outbound: `${cc}-hy2`,
        })),
      },
    };
    writeFileSync(configPath, JSON.stringify(templateCfg, null, 2), "utf8");
    const code = await runAddSub(["https://example.com/sub"], {
      configPath,
      envPath,
      fetchImpl: stubFetch(SAMPLE_SUB),
    });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string; type?: string; server?: string }>;
      route: { rules: Array<{ inbound: string[]; outbound: string }> };
    };
    expect(cfg.outbounds.some((o) => (o.server ?? "").includes("YOUR_"))).toBe(false);
    const freshTags = ["vless-example.com-443", "trojan-example.net-8443"];
    for (const rule of cfg.route.rules) {
      expect(freshTags).toContain(rule.outbound);
    }
    expect(new Set(cfg.route.rules.map((r) => r.outbound)).size).toBe(2);
    const auto = cfg.outbounds.find((o) => o.tag === "auto") as unknown as { outbounds: string[] };
    expect(auto.outbounds.every((t) => freshTags.includes(t))).toBe(true);
  });

  test("xhttp nodes never take pool routes (pinned binary cannot speak xhttp)", async () => {
    const sub = [
      "proxies:",
      "  - name: vx",
      "    type: vless",
      "    server: example.com",
      "    port: 443",
      "    network: xhttp",
      "    uuid: 11111111-2222-3333-4444-555555555555",
      "    tls: true",
      "    servername: example.com",
      "    reality-opts:",
      "      public-key: PUB",
      "      short-id: SID",
      "    xhttp-opts:",
      "      path: /xhttp",
      "      mode: stream-up",
      "    client-fingerprint: chrome",
      "  - name: hy",
      "    type: hysteria2",
      "    server: example.com",
      "    port: 443",
      "    password: fake-pass",
      "    sni: example.com",
    ].join("\n");
    writeFileSync(
      configPath,
      JSON.stringify({
        inbounds: [1081, 1082].map((port) => ({ type: "socks", tag: `socks-${port}`, listen: "127.0.0.1", listen_port: port })),
        outbounds: [{ type: "direct", tag: "direct" }],
        route: {
          final: "direct",
          rules: [1081, 1082].map((port) => ({ inbound: [`socks-${port}`], action: "route", outbound: "direct" })),
        },
      }),
      "utf8",
    );
    expect(await runAddSub(["https://example.com/sub"], { configPath, envPath, fetchImpl: stubFetch(sub) })).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string; type?: string }>;
      route: { rules: Array<{ outbound: string }> };
    };
    // The xhttp node never merges (the pinned binary rejects the whole
    // config at load when one outbound carries an unknown transport) ...
    expect(cfg.outbounds.some((o) => o.type === "vless")).toBe(false);
    expect(cfg.outbounds.some((o) => o.type === "hysteria2")).toBe(true);
    expect(logs.join("\n")).toMatch(/added 1 node/);
    // ... and every pool route lands on the speakable hy2 node.
    expect(cfg.route.rules.length).toBe(2);
    for (const rule of cfg.route.rules) {
      expect(rule.outbound).toBe("hysteria2-example.com-443");
    }
  });

  test("rewire prunes dangling group refs left by removed outbounds", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        inbounds: [{ type: "socks", tag: "socks-1081", listen: "127.0.0.1", listen_port: 1081 }],
        outbounds: [
          { type: "direct", tag: "direct" },
          { type: "urltest", tag: "auto", outbounds: ["ghost-1", "ghost-2"] },
        ],
        route: { final: "direct", rules: [{ inbound: ["socks-1081"], action: "route", outbound: "ghost-1" }] },
      }),
      "utf8",
    );
    expect(await runAddSub(["https://example.com/sub"], { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) })).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      outbounds: Array<{ tag?: string; type?: string; outbounds?: string[] }>;
      route: { rules: Array<{ outbound: string }> };
    };
    const tags = new Set(cfg.outbounds.map((o) => o.tag));
    const auto = cfg.outbounds.find((o) => o.tag === "auto") as unknown as { outbounds: string[] };
    expect(auto.outbounds.length).toBeGreaterThan(0);
    for (const m of auto.outbounds) expect(tags.has(m)).toBe(true);
    expect(cfg.route.rules[0]?.outbound).toBe("vless-example.com-443");
  });

  test("sets EGRESS_UPSTREAMS from socks inbounds when empty, never overwrites", async () => {
    const mkCfg = () => ({
      inbounds: [1081, 1082].map((port) => ({
        type: "socks",
        tag: `socks-${port}`,
        listen: "127.0.0.1",
        listen_port: port,
      })),
      outbounds: [],
      route: { final: "direct", rules: [] },
    });
    writeFileSync(configPath, JSON.stringify(mkCfg(), null, 2), "utf8");
    writeFileSync(envPath, "PORT=20128\nEGRESS_UPSTREAMS=\n", "utf8");
    expect(await runAddSub(["https://example.com/sub"], { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) })).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain("EGRESS_UPSTREAMS=socks5h://127.0.0.1:1081,socks5h://127.0.0.1:1082");
    writeFileSync(envPath, "PORT=20128\nEGRESS_UPSTREAMS=socks5h://127.0.0.1:1099\n", "utf8");
    expect(await runAddSub(["https://example.com/sub"], { configPath, envPath, fetchImpl: stubFetch(SAMPLE_SUB) })).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain("EGRESS_UPSTREAMS=socks5h://127.0.0.1:1099");
  });
});
