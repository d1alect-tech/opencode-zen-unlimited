import type { ConvertOptions, NormalizedNode, Proto, RealityConfig, TransportConfig } from "./types.ts";

/** Build a Reality config; undefined unless both key and id are present. */
export function realityFrom(publicKey?: string, shortId?: string): RealityConfig | undefined {
  if (!publicKey || !shortId) return undefined;
  return { public_key: publicKey, short_id: shortId };
}

/** Build a transport config; undefined for tcp/none/missing networks. */
export function transportFrom(
  network?: string | null,
  path?: string | null,
  mode?: string | null,
): TransportConfig | undefined {
  const type = (network ?? "").trim().toLowerCase();
  if (type === "" || type === "tcp" || type === "none") return undefined;
  return {
    type,
    ...(path ? { path } : {}),
    ...(mode ? { mode } : {}),
  };
}

const PROTO_SET: ReadonlySet<string> = new Set(["vless", "vmess", "trojan", "ss", "hysteria2"]);

/** Strip [] brackets, trim, range-check port, apply hy2 alpn h3 default. */
export function normalizeNode(node: NormalizedNode): NormalizedNode {
  const server = node.server.trim().replace(/^\[+|\]+$/g, "").trim();
  if (server === "") throw new Error("invalid node: empty host");
  if (!Number.isInteger(node.server_port) || node.server_port < 1 || node.server_port > 65535) {
    throw new Error(`invalid node port: ${String(node.server_port)}`);
  }
  if (node.proto === "hysteria2") {
    const tls = node.tls ?? { enabled: true };
    const alpn = tls.alpn && tls.alpn.length > 0 ? tls.alpn : ["h3"];
    return { ...node, server, tls: { ...tls, enabled: true, alpn } };
  }
  return { ...node, server };
}

/** Keep only included protos; drop nodes whose tag hits an exclude keyword. */
export function filterNodes(nodes: NormalizedNode[], opts: ConvertOptions = {}): NormalizedNode[] {
  const include = opts.includeProtos;
  const excludes = (opts.excludeKeywords ?? []).map((k) => k.toLowerCase());
  return nodes.filter((n) => {
    if (include && include.length > 0 && !include.includes(n.proto)) return false;
    if (excludes.length > 0) {
      const hay = `${n.rawTag ?? ""} ${n.server}`.toLowerCase();
      if (excludes.some((k) => k !== "" && hay.includes(k))) return false;
    }
    return true;
  });
}

/** Dedup by lowercased (host, port, proto). Keeps the first occurrence.
 *  Proto is part of the key: one host:port can serve several transports
 *  (e.g. vless-xhttp + hysteria2 twins) and each is a distinct pool member.
 */
export function dedupNodes(nodes: NormalizedNode[]): NormalizedNode[] {
  const seen = new Set<string>();
  const out: NormalizedNode[] = [];
  for (const n of nodes) {
    const key = `${n.server.toLowerCase()}:${n.server_port}:${n.proto}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** Stable tags {proto}-{host}-{port}; collisions get -2, -3 suffixes. */
export function assignTags(nodes: NormalizedNode[]): string[] {
  const used = new Map<string, number>();
  return nodes.map((n) => {
    const base = `${n.proto}-${n.server}-${n.server_port}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export function assertProto(value: string): asserts value is Proto {
  if (!PROTO_SET.has(value)) throw new Error(`unknown proto: ${value}`);
}
