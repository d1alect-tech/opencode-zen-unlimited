import type { NormalizedNode } from "../types.ts";

/** hysteria2://password@host:port?sni=host&insecure=0&alpn=h3#tag (hy2:// alias accepted). */
export function parseHysteria2(line: string): NormalizedNode {
  const url = new URL(line.replace(/^(hysteria2|hy2):\/\//i, "hysteria2://"));
  const password = decodeURIComponent(url.username);
  if (password === "") throw new Error("invalid hysteria2 link: missing password");
  const host = url.hostname;
  if (host === "") throw new Error("invalid hysteria2 link: missing host");
  const port = Number(url.port || "443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid hysteria2 port: ${url.port}`);
  }
  const q = url.searchParams;
  const alpnRaw = q.get("alpn") ?? q.get("alpn-protocol");
  const alpn = alpnRaw ? alpnRaw.split(",").map((s) => s.trim()).filter((s) => s !== "") : ["h3"];
  return {
    proto: "hysteria2",
    server: host,
    server_port: port,
    password,
    tls: {
      enabled: true,
      server_name: q.get("sni") ?? q.get("peer") ?? host,
      insecure: q.get("insecure") === "1" || q.get("skip-cert-verify") === "1" ? true : undefined,
      alpn,
    },
    rawTag: decodeURIComponent(url.hash.replace(/^#/, "")) || undefined,
  };
}
