import type { NormalizedNode, RelayUpstream, SingboxConfig, SingboxOutbound, TemplateInput, TlsConfig } from "./types.ts";

/**
 * Map normalized TLS to the sing-box shape: Reality becomes
 * `tls.reality`, the uTLS fingerprint becomes `tls.utls`.
 */
function tlsOut(tls: TlsConfig): Record<string, unknown> {
  const { fingerprint, reality, ...rest } = tls;
  return {
    ...rest,
    ...(reality !== undefined ? { reality: { enabled: true, ...reality } } : {}),
    ...(fingerprint !== undefined ? { utls: { enabled: true, fingerprint } } : {}),
  };
}

/** Map one normalized node to its sing-box outbound dict. */
export function nodeToOutbound(node: NormalizedNode, tag: string): SingboxOutbound {
  switch (node.proto) {
    case "vless":
      if (!node.uuid) throw new Error("vless node missing uuid");
      return {
        type: "vless",
        tag,
        server: node.server,
        server_port: node.server_port,
        uuid: node.uuid,
        ...(node.flow ? { flow: node.flow } : {}),
        ...(node.tls ? { tls: tlsOut(node.tls) } : {}),
        ...(node.transport ? { transport: { ...node.transport } } : {}),
        ...(node.packetEncoding ? { packet_encoding: node.packetEncoding } : {}),
      };
    case "vmess":
      if (!node.uuid) throw new Error("vmess node missing uuid");
      return {
        type: "vmess",
        tag,
        server: node.server,
        server_port: node.server_port,
        uuid: node.uuid,
        security: node.security ?? "auto",
        ...(node.alterId !== undefined ? { alter_id: node.alterId } : {}),
        ...(node.tls ? { tls: tlsOut(node.tls) } : {}),
      };
    case "trojan":
      if (!node.password) throw new Error("trojan node missing password");
      return {
        type: "trojan",
        tag,
        server: node.server,
        server_port: node.server_port,
        password: node.password,
        tls: node.tls ? tlsOut(node.tls) : { enabled: true, server_name: node.server },
      };
    case "ss":
      if (!node.method || !node.password) throw new Error("ss node missing method/password");
      return {
        type: "shadowsocks",
        tag,
        server: node.server,
        server_port: node.server_port,
        method: node.method,
        password: node.password,
      };
    case "hysteria2": {
      if (!node.password) throw new Error("hysteria2 node missing password");
      const tls = node.tls ?? { enabled: true };
      const alpn = tls.alpn && tls.alpn.length > 0 ? tls.alpn : ["h3"];
      // No utls here: sing-box v1.14 rejects uTLS usage on hysteria2
      // at runtime (check passes, connection fails). Fingerprint stays
      // in the normalized node for transports that support it.
      const hyTls: Record<string, unknown> = { ...tls, enabled: true, alpn };
      delete hyTls.fingerprint;
      delete hyTls.reality;
      return {
        type: "hysteria2",
        tag,
        server: node.server,
        server_port: node.server_port,
        password: node.password,
        tls: hyTls,
      };
    }
  }
}

export function nodeToUpstream(node: NormalizedNode, tag: string): RelayUpstream {
  return { tag, server: node.server, port: node.server_port, proto: node.proto };
}

const REQUIRED_KEYS: Record<string, string[]> = {
  vless: ["type", "tag", "server", "server_port", "uuid"],
  vmess: ["type", "tag", "server", "server_port", "uuid"],
  trojan: ["type", "tag", "server", "server_port", "password", "tls"],
  shadowsocks: ["type", "tag", "server", "server_port", "method", "password"],
  hysteria2: ["type", "tag", "server", "server_port", "password", "tls"],
};

/** Structural check: every emitted outbound carries its type's required keys. */
export function validateOutbound(ob: SingboxOutbound): void {
  const required = REQUIRED_KEYS[ob.type];
  if (!required) throw new Error(`unknown outbound type: ${String(ob.type)}`);
  for (const key of required) {
    if (ob[key] === undefined || ob[key] === "") {
      throw new Error(`outbound ${ob.tag} (${ob.type}) missing required key: ${key}`);
    }
  }
}

function expandPlaceholders(value: unknown, tags: string[]): unknown {
  if (typeof value === "string") {
    if (value === "{all}") return [...tags];
    if (value === "{all-first}") return tags[0] ?? "direct";
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (item === "{all}") out.push(...tags);
      else if (item === "{all-first}") out.push(tags[0] ?? "direct");
      else out.push(expandPlaceholders(item, tags));
    }
    return out;
  }
  if (value !== null && typeof value === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = expandPlaceholders(v, tags);
    }
    return obj;
  }
  return value;
}

/**
 * Merge generated outbounds into a template: {all} expands to every tag
 * inside selector/urltest outbounds lists, route.final {all-first} pins tag[0].
 */
export function buildSingboxConfig(
  nodeOutbounds: SingboxOutbound[],
  tags: string[],
  template?: TemplateInput,
): SingboxConfig {
  for (const ob of nodeOutbounds) validateOutbound(ob);
  const templateOutbounds = ((template?.outbounds ?? []) as unknown[]).map(
    (o) => expandPlaceholders(o, tags) as unknown as SingboxOutbound,
  );
  const routeRaw = (template?.route ?? { final: tags[0] ?? "direct" }) as Record<string, unknown>;
  const route = expandPlaceholders(routeRaw, tags) as SingboxConfig["route"];
  return { outbounds: [...nodeOutbounds, ...templateOutbounds], route };
}
