/**
 * `zen add-proxy <url>...` — append purchased-proxy URLs to `.env`
 * `EGRESS_UPSTREAMS` with dedup.
 *
 * Accepts every scheme `dispatcher.ts` can egress through (`PROXY_SCHEMES`:
 * SOCKS pool + `http://` / `https://` purchased proxies); anything else
 * (e.g. `vless:` node links — those go through `zen add-sub`) is a usage
 * error. Auth (`user:pass@`) is optional and passes through untouched.
 * All URLs validate before anything is written: one bad URL rejects the
 * whole call and `.env` stays byte-identical.
 *
 * stdout never carries credentials: only added/total counts and a
 * `zen doctor` pointer. The `.env` file gets a `.bak` backup before
 * mutation (same contract as `add-sub`'s `backup` + `upsertEnvKey`).
 *
 * Exit codes: 0 ok (including idempotent 0-added reruns), 2 usage /
 * bad URL, 1 operational failure (unreadable/unwritable `.env`).
 * Never throws for usage errors.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { COMMAND_HELP } from "../parser.ts";
import { PROXY_SCHEMES, parseEgressUpstreams } from "../../gateway/dispatcher.ts";
import { backup, upsertEnvKey } from "./add-sub.ts";

export const ADD_PROXY_HELP: string = COMMAND_HELP["add-proxy"];

export interface AddProxyDeps {
  readonly envPath?: string;
}

function parseAddProxyArgs(
  rest: readonly string[],
): { ok: true; urls: string[] } | { ok: false; message: string } {
  const urls: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("-")) {
      return { ok: false, message: `error: unknown option '${arg}'\n${ADD_PROXY_HELP}` };
    }
    urls.push(arg);
  }
  if (urls.length === 0) {
    return { ok: false, message: `error: missing proxy url\n${ADD_PROXY_HELP}` };
  }
  return { ok: true, urls };
}

/**
 * Throw a usage-flavored error unless `raw` is a supported proxy URL.
 * Returns the trimmed original (spelling preserved: `socks5h://` stays
 * `socks5h://`, exactly like `add-sub`-derived upstreams); only the scheme
 * check runs on the dispatcher-normalized form.
 */
function validateProxyUrl(raw: string): string {
  const trimmed: string = raw.trim();
  const normalized: string = trimmed.replace(/^socks5h:\/\//i, "socks5://");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`error: invalid proxy URL '${raw}'\n${ADD_PROXY_HELP}`);
  }
  const scheme: string = parsed.protocol.toLowerCase().replace(/:$/, "");
  if (!PROXY_SCHEMES.has(scheme)) {
    throw new Error(
      `error: unsupported proxy scheme '${parsed.protocol}' (expected socks5/socks/socks4/socks4a/http/https)\n${ADD_PROXY_HELP}`,
    );
  }
  return trimmed;
}

function readEnvValue(envText: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "m").exec(envText);
  return match?.[1];
}

/**
 * Run `zen add-proxy`. Returns the process exit code: 0 ok, 2 usage /
 * bad-url, 1 operational failure. Never throws for usage errors.
 */
export async function runAddProxy(
  rest: readonly string[],
  deps: AddProxyDeps = {},
): Promise<number> {
  const parsed = parseAddProxyArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }

  let urls: string[];
  try {
    urls = parsed.urls.map(validateProxyUrl);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const envPath = deps.envPath ?? ".env";
  let envText = "";
  try {
    if (existsSync(envPath)) {
      envText = readFileSync(envPath, "utf8");
    }
  } catch (err) {
    console.error(
      `error: cannot read .env at ${envPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const seen = new Set(
    parseEgressUpstreams({ EGRESS_UPSTREAMS: readEnvValue(envText, "EGRESS_UPSTREAMS") }),
  );
  const fresh = urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  const merged: string = [...seen].join(",");
  const next: string = upsertEnvKey(envText, "EGRESS_UPSTREAMS", merged);

  try {
    backup(envPath);
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, next, "utf8");
  } catch (err) {
    console.error(
      `error: failed to write .env: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const noun = fresh.length === 1 ? "proxy URL" : "proxy URLs";
  console.log(
    `added ${fresh.length} ${noun} to EGRESS_UPSTREAMS (${seen.size} total).`,
  );
  console.log("next: run `zen doctor` to verify gateway, relay and egress health.");
  return 0;
}
