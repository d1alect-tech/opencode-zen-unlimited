import { decodeBase64Text, detectFormat, splitLines } from "./detect.ts";
import { buildSingboxConfig, nodeToOutbound, nodeToUpstream, validateOutbound } from "./emit.ts";
import { fetchSub } from "./fetch.ts";
import { assignTags, dedupNodes, filterNodes, normalizeNode } from "./normalize.ts";
import { parseUri } from "./parsers/index.ts";
import type {
  ConvertOptions,
  ConvertResult,
  NormalizedNode,
  Proto,
  SingboxOutbound,
  TemplateInput,
} from "./types.ts";

export type { ConvertOptions, ConvertResult } from "./types.ts";

/** Proxy `type:` values that are selectors/groups, not servers — skipped, not converted. */
const GROUP_TYPES: ReadonlySet<string> = new Set([
  "select",
  "url-test",
  "fallback",
  "load-balance",
  "relay",
  "direct",
  "reject",
  "pass",
]);

/** Minimal Clash `proxies:` section parser — no YAML dependency. */
export function parseClashYaml(text: string): NormalizedNode[] {
  const lines = text.split(/\r?\n/);
  // Top-level `proxies:` only: proxy-groups entries contain a nested `proxies:`
  // member list that must not hijack the section scan.
  const proxiesIdx = lines.findIndex((l) => /^proxies\s*:/.test(l));
  if (proxiesIdx < 0) throw new Error("clash yaml has no proxies: section");
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  let baseIndent = -1;
  let skippedGroups = 0;
  const closeRecord = (): void => {
    if (current === null) return;
    if (Object.keys(current).length === 0) {
      current = null; // parser artifact (nested list item) — drop silently
      return;
    }
    const type = (current["type"] ?? "").toLowerCase();
    if (GROUP_TYPES.has(type)) {
      skippedGroups += 1; // selector group, not a server — drop
    } else {
      records.push(current);
    }
    current = null;
  };
  for (const line of lines.slice(proxiesIdx + 1)) {
    if (/^\S/.test(line) && line.trim() !== "" && !line.startsWith(" ")) {
      break; // next top-level section
    }
    const itemStart = line.match(/^(\s*)-\s*(.*)$/);
    if (itemStart) {
      const indent = (itemStart[1] ?? "").length;
      if (baseIndent < 0) baseIndent = indent;
      if (indent !== baseIndent) continue; // nested list (alpn, group members) — not a record
      closeRecord();
      current = {};
      const rest = (itemStart[2] ?? "").trim();
      if (rest !== "") {
        const kv = rest.match(/^([\w-]+)\s*:\s*(.*)$/);
        if (kv) current[kv[1] as string] = stripQuotes((kv[2] ?? "").trim());
      }
      continue;
    }
    if (current) {
      const kv = line.match(/^\s+([\w-]+)\s*:\s*(.*)$/);
      if (kv) current[kv[1] as string] = stripQuotes((kv[2] ?? "").trim());
    }
  }
  closeRecord();
  if (records.length === 0 && skippedGroups > 0) {
    throw new Error(
      `clash yaml has only selector groups (${skippedGroups} skipped: select/url-test/…), no server nodes — this looks like a ClashVerge preset, not a node subscription`,
    );
  }
  return records.map(clashProxyToNode);
}

function stripQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function clashProxyToNode(p: Record<string, string>): NormalizedNode {
  const type = (p["type"] ?? "").toLowerCase();
  const server = (p["server"] ?? "").trim();
  const port = Number(p["port"] ?? "0");
  if (server === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`clash proxy has bad server/port: ${p["name"] ?? type}`);
  }
  const sni = p["sni"] ?? p["servername"] ?? undefined;
  const insecure = p["skip-cert-verify"] === "true";
  switch (type) {
    case "vless": {
      if (!p["uuid"]) throw new Error("clash vless proxy missing uuid");
      const tlsOn = p["tls"] === "true";
      return {
        proto: "vless",
        server,
        server_port: port,
        uuid: p["uuid"],
        flow: p["flow"] || undefined,
        network: p["network"] || undefined,
        tls: tlsOn ? { enabled: true, server_name: sni ?? server, insecure: insecure || undefined } : undefined,
        rawTag: p["name"],
      };
    }
    case "vmess": {
      if (!p["uuid"]) throw new Error("clash vmess proxy missing uuid");
      const tlsOn = p["tls"] === "true";
      return {
        proto: "vmess",
        server,
        server_port: port,
        uuid: p["uuid"],
        security: p["cipher"] || "auto",
        alterId: p["alterId"] !== undefined ? Number(p["alterId"]) : 0,
        tls: tlsOn ? { enabled: true, server_name: sni ?? server, insecure: insecure || undefined } : undefined,
        rawTag: p["name"],
      };
    }
    case "trojan": {
      if (!p["password"]) throw new Error("clash trojan proxy missing password");
      return {
        proto: "trojan",
        server,
        server_port: port,
        password: p["password"],
        tls: { enabled: true, server_name: sni ?? server, insecure: insecure || undefined },
        rawTag: p["name"],
      };
    }
    case "ss":
    case "shadowsocks": {
      if (!p["cipher"] || !p["password"]) throw new Error("clash ss proxy missing cipher/password");
      return { proto: "ss", server, server_port: port, method: p["cipher"], password: p["password"], rawTag: p["name"] };
    }
    case "hysteria2":
    case "hy2": {
      if (!p["password"]) throw new Error("clash hysteria2 proxy missing password");
      return {
        proto: "hysteria2",
        server,
        server_port: port,
        password: p["password"],
        tls: { enabled: true, server_name: sni ?? server, insecure: insecure || undefined, alpn: ["h3"] },
        rawTag: p["name"],
      };
    }
    default:
      throw new Error(`unsupported clash proxy type: ${type === "" ? "(missing)" : type}`);
  }
}

const JSON_TYPE_TO_PROTO: Record<string, Proto> = {
  vless: "vless",
  vmess: "vmess",
  trojan: "trojan",
  shadowsocks: "ss",
  ss: "ss",
  hysteria2: "hysteria2",
  hy2: "hysteria2",
};

/** Map a sing-box/clash JSON outbound list to normalized nodes. */
export function parseJsonNodes(value: unknown): NormalizedNode[] {
  const list: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { outbounds?: unknown }).outbounds)
      ? (value as { outbounds: unknown[] }).outbounds
      : typeof value === "object" && value !== null && Array.isArray((value as { proxies?: unknown }).proxies)
        ? (value as { proxies: unknown[] }).proxies
        : [];
  return list.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("json node entry is not an object");
    const e = entry as Record<string, unknown>;
    const proto = JSON_TYPE_TO_PROTO[String(e["type"] ?? "").toLowerCase()];
    if (!proto) throw new Error(`unsupported json node type: ${String(e["type"] ?? "(missing)")}`);
    const server = String(e["server"] ?? "");
    const port = Number(e["server_port"] ?? e["port"] ?? 0);
    if (server === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("json node has bad server/port");
    }
    const tlsRaw = e["tls"] as { server_name?: unknown; insecure?: unknown; alpn?: unknown } | undefined;
    return {
      proto,
      server,
      server_port: port,
      uuid: e["uuid"] !== undefined ? String(e["uuid"]) : undefined,
      password: e["password"] !== undefined ? String(e["password"]) : undefined,
      method: e["method"] !== undefined ? String(e["method"]) : undefined,
      security: e["security"] !== undefined ? String(e["security"]) : undefined,
      tls:
        tlsRaw !== undefined
          ? {
              enabled: true,
              server_name: tlsRaw.server_name !== undefined ? String(tlsRaw.server_name) : server,
              insecure: tlsRaw.insecure === true ? true : undefined,
              alpn: Array.isArray(tlsRaw.alpn) ? tlsRaw.alpn.map(String) : undefined,
            }
          : undefined,
      rawTag: e["tag"] !== undefined ? String(e["tag"]) : undefined,
    } satisfies NormalizedNode;
  });
}

/** Full pipeline: raw subscription text -> sing-box outbounds + relay upstreams. */
export function convertSubContent(raw: string, opts: ConvertOptions = {}, template?: TemplateInput): ConvertResult {
  const format = detectFormat(raw);
  let candidates: NormalizedNode[] = [];
  const errors: string[] = [];
  let dropped = 0;

  const collectUri = (lines: string[]): void => {
    for (const line of lines) {
      try {
        candidates.push(normalizeNode(parseUri(line)));
      } catch (err) {
        dropped += 1;
        errors.push(`${line.slice(0, 32)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      for (const n of parseJsonNodes(parsed)) {
        try {
          candidates.push(normalizeNode(n));
        } catch (err) {
          dropped += 1;
          errors.push(`json-node: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      throw new Error(`invalid json subscription: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (format === "clash-yaml") {
    try {
      for (const n of parseClashYaml(raw)) {
        try {
          candidates.push(normalizeNode(n));
        } catch (err) {
          dropped += 1;
          errors.push(`clash-node: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      throw new Error(`invalid clash yaml: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (format === "base64-uri") {
    collectUri(splitLines(decodeBase64Text(raw.trim())));
  } else {
    collectUri(splitLines(raw));
  }

  const filtered = filterNodes(candidates, opts);
  dropped += candidates.length - filtered.length;
  const deduped = dedupNodes(filtered);
  dropped += filtered.length - deduped.length;

  if (deduped.length === 0) {
    throw new Error(`no valid nodes: ${dropped} dropped (${errors.slice(0, 3).join("; ") || "empty input"})`);
  }

  const tags = assignTags(deduped);
  const outbounds: SingboxOutbound[] = deduped.map((n, i) => nodeToOutbound(n, tags[i] as string));
  for (const ob of outbounds) validateOutbound(ob);
  const singboxConfig = buildSingboxConfig(outbounds, tags, template);
  const relayUpstreams = deduped.map((n, i) => nodeToUpstream(n, tags[i] as string));
  return { outbounds, relayUpstreams, singboxConfig, dropped, errors };
}

/** Fetch a subscription URL (SSRF-guarded) then convert it. */
export async function convertSubUrl(
  url: string,
  opts: ConvertOptions = {},
  template?: TemplateInput,
): Promise<ConvertResult> {
  const raw = await fetchSub(url);
  return convertSubContent(raw, opts, template);
}
