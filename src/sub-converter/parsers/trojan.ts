import type { NormalizedNode } from "../types.ts";

/** trojan://password@host:port?sni=host&allowInsecure=0#tag — TLS always on. */
export function parseTrojan(line: string): NormalizedNode {
  const url = new URL(line.replace(/^trojan:\/\//i, "trojan://"));
  const password = decodeURIComponent(url.username);
  if (password === "") throw new Error("invalid trojan link: missing password");
  const host = url.hostname;
  if (host === "") throw new Error("invalid trojan link: missing host");
  const port = Number(url.port || "443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid trojan port: ${url.port}`);
  }
  const q = url.searchParams;
  const insecure = q.get("allowInsecure") === "1" || q.get("allowinsecure") === "1";
  return {
    proto: "trojan",
    server: host,
    server_port: port,
    password,
    tls: {
      enabled: true,
      server_name: q.get("sni") ?? q.get("peer") ?? host,
      insecure: insecure ? true : undefined,
    },
    rawTag: decodeURIComponent(url.hash.replace(/^#/, "")) || undefined,
  };
}
