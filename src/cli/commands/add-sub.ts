/**
 * `zen add-sub <url> [--name <prefix>]` (plan T11, T9 human-429 recovery path).
 *
 * Fetches a subscription link (SSRF-guarded, http/https only), parses nodes
 * through the sub-converter pipeline (`convertSubContent`: detect, parsers,
 * normalize, emit — reused, never reimplemented here), appends non-duplicate
 * outbounds to the sing-box config JSON, and records the link as
 * `EGRESS_SUB_URL` in `.env`. Both files get a `.bak` backup before mutation.
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
import { validateSubUrl, fetchSub } from "../../sub-converter/fetch.ts";
import { convertSubContent } from "../../sub-converter/index.ts";
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

/** Dedup key: lowercased host:port when known, else the outbound tag. */
function outboundKey(ob: SingboxOutbound): string {
  if (typeof ob["server"] === "string" && typeof ob["server_port"] === "number") {
    return `${(ob["server"] as string).toLowerCase()}:${ob["server_port"] as number}`;
  }
  return `tag:${ob.tag}`;
}

function backup(path: string): void {
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
  }
}

/** Replace or append the EGRESS_SUB_URL line, preserving every other line. */
function upsertEnvLine(envText: string, url: string): string {
  const lines = envText.split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    if (/^\s*EGRESS_SUB_URL\s*=/.test(line)) {
      found = true;
      return `EGRESS_SUB_URL=${url}`;
    }
    return line;
  });
  if (!found) {
    if (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
    out.push(`EGRESS_SUB_URL=${url}`);
  }
  return `${out.join("\n")}\n`;
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

  let raw: string;
  try {
    raw = await fetchSub(url, { fetchImpl });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  let outbounds: SingboxOutbound[];
  try {
    outbounds = convertSubContent(raw).outbounds;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

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

  try {
    backup(configPath);
    backup(envPath);
    mkdirSync(dirname(configPath), { recursive: true });
    (config.outbounds as SingboxOutbound[]).push(...fresh);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, upsertEnvLine(envText, url), "utf8");
  } catch (err) {
    console.error(`error: failed to write config/env: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const total = (config.outbounds as SingboxOutbound[]).length;
  const host = new URL(url).hostname;
  const noun = fresh.length === 1 ? "node" : "nodes";
  console.log(`added ${fresh.length} ${noun} from ${host} (${total} in config).`);
  console.log("next: run `zen doctor` to verify gateway, relay and egress health.");
  return 0;
}
