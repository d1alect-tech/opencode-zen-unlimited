import type { NormalizedNode, TlsConfig } from "../types.ts";

function numPort(port: string, scheme: string): number {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid ${scheme} port: ${port}`);
  }
  return n;
}

function tlsFrom(security: string | null, sni: string | null, host: string): TlsConfig | undefined {
  const sec = (security ?? "").toLowerCase();
  if (sec === "tls" || sec === "reality") {
    return { enabled: true, server_name: sni ?? host };
  }
  return undefined;
}

/** vless://uuid@host:port?encryption=none&security=tls&sni=host&flow=...#tag */
export function parseVless(line: string): NormalizedNode {
  const url = new URL(line);
  const uuid = decodeURIComponent(url.username);
  if (uuid === "") throw new Error("invalid vless link: missing uuid");
  const host = url.hostname;
  if (host === "") throw new Error("invalid vless link: missing host");
  const q = url.searchParams;
  return {
    proto: "vless",
    server: host,
    server_port: numPort(url.port || "443", "vless"),
    uuid,
    flow: q.get("flow") ?? undefined,
    network: q.get("type") ?? q.get("network") ?? undefined,
    tls: tlsFrom(q.get("security"), q.get("sni") ?? q.get("peer"), host),
    rawTag: decodeURIComponent(url.hash.replace(/^#/, "")) || undefined,
  };
}
