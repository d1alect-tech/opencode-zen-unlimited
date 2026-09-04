/**
 * `zen add-sub <url> [--name <prefix>]` (plan T11, T9 human-429 recovery path).
 *
 * Fetches a subscription link (SSRF-guarded, http/https only), parses nodes
 * through the sub-converter pipeline (`convertSubContent`: detect, parsers,
 * normalize, emit — reused, never reimplemented here), appends non-duplicate
 * outbounds to the sing-box config JSON, and records the link as
 * `EGRESS_SUB_URL` in `.env`. Both files get a `.bak` backup before mutation.
 * Providers may sniff the User-Agent and return different bodies per client
 * (preset for browsers, full node list for clash clients), so every UA
 * candidate is fetched and converted and the richest result wins.
 *
 * stdout never carries secrets: only the subscription host, added/total
 * counts, and a `zen doctor` pointer. Full node URLs, uuids, and passwords
 * stay in the files.
 *
 * Exit codes: 0 ok (including idempotent 0-added reruns), 2 usage / bad URL
 * / fetch failure / malformed subscription (zero valid nodes). Never throws
 * for usage errors; unexpected I/O failures also report as exit 2 with an
 * `error:` line.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMMAND_HELP } from "../parser.ts";
import { validateSubUrl, fetchSub, BROWSER_UA, CLASHMETA_UA } from "../../sub-converter/fetch.ts";
import { convertSubContent, type ConvertResult } from "../../sub-converter/index.ts";
import type { SingboxOutbound } from "../../sub-converter/types.ts";

export const ADD_SUB_HELP: string = COMMAND_HELP["add-sub"];

export interface AddSubDeps {
  readonly configPath?: string;
  readonly envPath?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ParsedAddSub {
  readonly url: string;
  readonly name: string | undefined;
}

function parseAddSubArgs(rest: readonly string[]): { ok: true; parsed: ParsedAddSub } | { ok: false; message: string } {
  let url: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--name") {
      const value = rest[i + 1];
      if (value === undefined || value === "") {
        return { ok: false, message: `error: --name needs a value\n${ADD_SUB_HELP}` };
      }
      name = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `error: unknown option '${arg}'\n${ADD_SUB_HELP}` };
    } else if (url === undefined) {
      url = arg;
    } else {
      return { ok: false, message: `error: unexpected argument '${arg}'\n${ADD_SUB_HELP}` };
    }
  }
  if (url === undefined) {
    return { ok: false, message: `error: missing subscription url\n${ADD_SUB_HELP}` };
  }
  return { ok: true, parsed: { url, name } };
}

/** Dedup key: lowercased proto/host:port when known, else the outbound tag.
 *  Proto is part of the key: one host:port can serve several transports
 *  (vless-xhttp + hysteria2 twins) and each is a distinct pool member. */
function outboundKey(ob: SingboxOutbound): string {
  if (typeof ob["server"] === "string" && typeof ob["server_port"] === "number") {
    return `${ob.type}/${(ob["server"] as string).toLowerCase()}:${ob["server_port"] as number}`;
  }
  return `tag:${ob.tag}`;
}

function backup(path: string): void {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
}

/** Replace or append a KEY=value line, preserving every other line. */
function upsertEnvKey(envText: string, key: string, value: string): string {
  const lines = envText.split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
    out.push(`${key}=${value}`);
  }
  return `${out.join("\n")}\n`;
}

/** Outbound types that carry real tunnel traffic (routable pool members). */
const TUNNEL_TYPES: ReadonlySet<string> = new Set([
  "vless",
  "vmess",
  "trojan",
  "ss",
  "shadowsocks",
  "hysteria2",
  "hy2",
]);

function outboundServer(ob: SingboxOutbound): string {
  const rec = ob as unknown as Record<string, unknown>;
  return typeof rec["server"] === "string" ? (rec["server"] as string) : "";
}

/** Template leftovers carry YOUR_* placeholder hosts — dead by definition. */
function isPlaceholderServer(ob: SingboxOutbound): boolean {
  const server = outboundServer(ob);
  return server === "" || server.includes("YOUR_");
}

/** Transports the pinned sing-box binary cannot speak (v1.14 has no xhttp).
 *  Such nodes stay in the config (future binary upgrade) but never take pool routes. */
const UNSPEAKABLE_TRANSPORTS: ReadonlySet<string> = new Set(["xhttp"]);

function outboundTransport(ob: SingboxOutbound): string {
  const rec = ob as unknown as Record<string, unknown>;
  const t = rec["transport"];
  if (typeof t === "object" && t !== null) {
    const type = (t as { type?: unknown }).type;
    return typeof type === "string" ? type.toLowerCase() : "";
  }
  return "";
}

function isRoutable(ob: SingboxOutbound): boolean {
  return (
    TUNNEL_TYPES.has(ob.type) && !isPlaceholderServer(ob) && !UNSPEAKABLE_TRANSPORTS.has(outboundTransport(ob))
  );
}

/** Loopback socks inbound ports, sorted — the relay pool endpoints. */
function collectSocksPorts(config: { inbounds?: unknown; [key: string]: unknown }): number[] {
  if (!Array.isArray(config.inbounds)) return [];
  const ports: number[] = [];
  for (const ib of config.inbounds) {
    const rec = ib as { type?: unknown; listen_port?: unknown };
    if (rec.type === "socks" && typeof rec.listen_port === "number") ports.push(rec.listen_port);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

interface PoolRewire {
  readonly assignedRules: number;
  readonly removedPlaceholders: number;
}

/**
 * Point socks route rules at distinct live nodes (round-robin over routable
 * outbounds), drop dead YOUR_* placeholder outbounds, repoint urltest /
 * selector groups at the assigned tags. No-op when nothing is routable.
 * Never throws for missing sections — template shapes vary.
 */
function rewirePool(config: { outbounds?: unknown[]; route?: unknown; inbounds?: unknown }): PoolRewire {
  const none = { assignedRules: 0, removedPlaceholders: 0 };
  if (!Array.isArray(config.outbounds)) return none;
  const outbounds = config.outbounds as SingboxOutbound[];
  const routable = outbounds.filter(isRoutable);
  if (routable.length === 0) return none;
  const placeholderTags = new Set(
    outbounds.filter((ob) => TUNNEL_TYPES.has(ob.type) && isPlaceholderServer(ob)).map((ob) => ob.tag),
  );
  const socksTags = new Set(
    (Array.isArray(config.inbounds) ? (config.inbounds as unknown[]) : [])
      .filter((ib) => (ib as { type?: unknown }).type === "socks")
      .map((ib) => (ib as { tag?: unknown }).tag)
      .filter((t): t is string => typeof t === "string"),
  );
  const route = (config.route ?? {}) as { rules?: unknown };
  const rules = Array.isArray(route.rules) ? (route.rules as Array<Record<string, unknown>>) : [];
  const assignedOrdered: string[] = [];
  let cursor = 0;
  let assignedRules = 0;
  for (const rule of rules) {
    const inbounds = Array.isArray(rule["inbound"]) ? (rule["inbound"] as unknown[]) : [];
    if (!inbounds.some((t) => typeof t === "string" && socksTags.has(t as string))) continue;
    const pick = routable[cursor % routable.length] as SingboxOutbound;
    rule["outbound"] = pick.tag;
    if (!assignedOrdered.includes(pick.tag)) assignedOrdered.push(pick.tag);
    cursor += 1;
    assignedRules += 1;
  }
  const remaining: SingboxOutbound[] = outbounds.filter((ob) => !placeholderTags.has(ob.tag));
  config.outbounds = remaining;
  // Dangling refs brick startup (sing-box run FATALs on missing group deps
  // while check stays green), so prune every member tag that no longer
  // exists — placeholders, removed nodes, anything. Refill emptied groups
  // with the freshly routed tags so urltest never ends up with zero members.
  const liveTags = new Set(remaining.map((ob) => ob.tag));
  const groupTargets = assignedOrdered.length > 0 ? assignedOrdered : routable.map((ob) => ob.tag);
  for (const ob of remaining) {
    if (ob.type !== "selector" && ob.type !== "urltest") continue;
    const rec = ob as unknown as Record<string, unknown>;
    if (!Array.isArray(rec["outbounds"])) continue;
    const kept = (rec["outbounds"] as unknown[]).filter(
      (m) => typeof m === "string" && liveTags.has(m as string),
    );
    for (const t of groupTargets) {
      if (!kept.includes(t)) kept.push(t);
    }
    rec["outbounds"] = kept;
  }
  return { assignedRules, removedPlaceholders: placeholderTags.size };
}

/**
 * Run `zen add-sub`. Returns the process exit code: 0 ok, 2 usage /
 * bad-url / fetch / malformed. Never throws for usage errors.
 */
export async function runAddSub(rest: readonly string[], deps: AddSubDeps = {}): Promise<number> {
  const parsed = parseAddSubArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const { url, name } = parsed.parsed;

  try {
    validateSubUrl(url);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const configPath = deps.configPath ?? "sing-box/config.json";
  const envPath = deps.envPath ?? ".env";
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Providers may sniff the User-Agent and return different bodies per client
  // (preset for browsers, full node list for clash clients). Fetch + convert
  // every UA candidate and keep the richest result.
  const CANDIDATE_UAS: readonly string[] = [BROWSER_UA, CLASHMETA_UA];
  let best: ConvertResult | undefined;
  let lastError = "subscription fetch failed";
  for (const ua of CANDIDATE_UAS) {
    let raw: string;
    try {
      raw = await fetchSub(url, { fetchImpl, userAgents: [ua] });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    try {
      const converted = convertSubContent(raw);
      if (best === undefined || converted.outbounds.length > best.outbounds.length) {
        best = converted;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (best === undefined) {
    console.error(`error: ${lastError}`);
    return 2;
  }
  // The pinned binary rejects unknown transports at load (check + run),
  // so unloadable nodes never merge: one bad outbound bricks the whole
  // config. The converter stays faithful (tests pin full shapes); the CLI
  // decides what this binary can load. A binary upgrade + rerun restores them.
  let outbounds: SingboxOutbound[] = best.outbounds.filter(
    (ob) => !UNSPEAKABLE_TRANSPORTS.has(outboundTransport(ob)),
  );

  if (name !== undefined) {
    outbounds = outbounds.map((ob) => ({ ...ob, tag: `${name}-${ob.tag}` }));
  }

  let configRaw: string;
  try {
    configRaw = readFileSync(configPath, "utf8");
  } catch {
    console.error(`error: cannot read sing-box config at ${configPath}`);
    return 2;
  }
  let config: { outbounds?: unknown[]; [key: string]: unknown };
  try {
    config = JSON.parse(configRaw) as { outbounds?: unknown[]; [key: string]: unknown };
  } catch {
    console.error(`error: sing-box config at ${configPath} is not valid JSON`);
    return 2;
  }
  if (!Array.isArray(config.outbounds)) config.outbounds = [];
  const seen = new Set(
    (config.outbounds as SingboxOutbound[]).map((ob) => outboundKey(ob)),
  );
  const fresh = outbounds.filter((ob) => {
    const key = outboundKey(ob);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let envText = "";
  try {
    envText = readFileSync(envPath, "utf8");
  } catch {
    envText = "";
  }

  // Pool rewiring runs on the merged config (existing + fresh).
  (config.outbounds as SingboxOutbound[]).push(...fresh);
  const rewire = rewirePool(config);
  envText = upsertEnvKey(envText, "EGRESS_SUB_URL", url);
  const ports = collectSocksPorts(config);
  let upstreamsSet = false;
  if (ports.length > 0 && !/^\s*EGRESS_UPSTREAMS\s*=[ \t]*\S/m.test(envText)) {
    envText = upsertEnvKey(
      envText,
      "EGRESS_UPSTREAMS",
      ports.map((p) => `socks5h://127.0.0.1:${p}`).join(","),
    );
    upstreamsSet = true;
  }

  try {
    backup(configPath);
    backup(envPath);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, envText, "utf8");
  } catch (err) {
    console.error(`error: failed to write config/env: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const total = (config.outbounds as SingboxOutbound[]).length;
  const host = new URL(url).hostname;
  const noun = fresh.length === 1 ? "node" : "nodes";
  console.log(`added ${fresh.length} ${noun} from ${host} (${total} in config).`);
  if (rewire.assignedRules > 0) {
    console.log(
      `pool: ${rewire.assignedRules} socks routes → live nodes, ${rewire.removedPlaceholders} dead placeholders dropped.`,
    );
  }
  if (upstreamsSet) {
    console.log("pool: EGRESS_UPSTREAMS derived from socks inbounds.");
  }
  console.log("next: run `zen doctor` to verify gateway, relay and egress health.");
  return 0;
}
