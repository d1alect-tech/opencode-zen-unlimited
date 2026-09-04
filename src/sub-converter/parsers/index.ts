import type { NormalizedNode } from "../types.ts";
import { parseHysteria2 } from "./hysteria2.ts";
import { parseSs } from "./ss.ts";
import { parseTrojan } from "./trojan.ts";
import { parseVless } from "./vless.ts";
import { parseVmess } from "./vmess.ts";

/** Dispatch a single URI line to its scheme parser. ssr is rejected, never parsed. */
export function parseUri(line: string): NormalizedNode {
  const trimmed = line.trim();
  const m = trimmed.match(/^([a-z0-9+.-]+):\/\//i);
  if (!m) throw new Error(`unsupported link (no scheme): ${trimmed.slice(0, 24)}`);
  const scheme = (m[1] ?? "").toLowerCase();
  switch (scheme) {
    case "vless":
      return parseVless(trimmed);
    case "vmess":
      return parseVmess(trimmed);
    case "trojan":
      return parseTrojan(trimmed);
    case "ss":
      return parseSs(trimmed);
    case "hysteria2":
    case "hy2":
      return parseHysteria2(trimmed);
    case "ssr":
      throw new Error("ssr protocol is not supported (rejected: no sing-box outbound maps it)");
    default:
      throw new Error(`unsupported scheme: ${scheme}`);
  }
}
