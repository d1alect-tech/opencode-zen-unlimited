/**
 * Per-egress undici dispatcher map for the gateway hot path.
 *
 * Rules:
 * - One cached agent per egress URL. Rotation/selection across the pool
 *   lands in a later task; this module serves single-egress default direct.
 * - The agent is passed as a per-request `dispatcher` fetch option.
 *   NEVER call `setGlobalDispatcher` here — the global stays untouched.
 * - Scheme switch: `socks5://`, `socks5h://`, `socks://` go through
 *   `Socks5ProxyAgent`; everything else goes through `ProxyAgent`.
 *
 * NOTE: agents are imported from the real undici package files instead of
 * the bare `undici` specifier because the Bun runtime shadows bare
 * `undici` with a builtin subset (missing `Socks5ProxyAgent`, divergent
 * types). See `undici-socks.d.ts` for the ambient declarations.
 */

import ProxyAgent from "undici/lib/dispatcher/proxy-agent.js";
import Socks5ProxyAgent from "undici/lib/dispatcher/socks5-proxy-agent.js";

/** Header wait budget for upstream responses. */
export const HEADERS_TIMEOUT_MS = 15_000;
/** Body stall budget — 30s+ so long SSE streams survive. */
export const BODY_TIMEOUT_MS = 35_000;

export type EgressAgent = ProxyAgent | Socks5ProxyAgent;

const agents = new Map<string, EgressAgent>();

function isSocksScheme(egressUrl: string): boolean {
  const scheme: string = egressUrl.split("://")[0]?.trim().toLowerCase() ?? "";
  return scheme === "socks5" || scheme === "socks5h" || scheme === "socks";
}

/** Parse `EGRESS_UPSTREAMS` ("url1,url2") into a trimmed list. */
export function parseEgressUpstreams(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw: string = env["EGRESS_UPSTREAMS"] ?? "";
  return raw
    .split(",")
    .map((entry: string) => entry.trim())
    .filter((entry: string) => entry.length > 0);
}

/** Build (or reuse the cached) agent for one egress URL.
 *
 * NOTE: `socks5h://` (hostname resolved remotely) is normalized to
 * `socks5://` because undici's `Socks5ProxyAgent` only accepts
 * `socks5://`/`socks://` schemes. SOCKS5 resolves domain names
 * server-side by default, so semantics are preserved.
 */
export function agentFor(egressUrl: string): EgressAgent {
  const target: string = egressUrl.replace(/^socks5h:\/\//i, "socks5://");
  const cached: EgressAgent | undefined = agents.get(target);
  if (cached !== undefined) return cached;
  const agent: EgressAgent = isSocksScheme(egressUrl)
    ? new Socks5ProxyAgent(target, {
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
      })
    : new ProxyAgent({
        uri: egressUrl,
        headersTimeout: HEADERS_TIMEOUT_MS,
        bodyTimeout: BODY_TIMEOUT_MS,
      });
  agents.set(target, agent);
  return agent;
}

/**
 * Dispatcher for the next upstream request.
 * - No `EGRESS_UPSTREAMS` configured -> `undefined` (direct connection
 *   through the default dispatcher; the global is never replaced).
 * - Configured -> the cached agent for the first entry (single-egress
 *   default; rotation lands in a later task).
 */
export function currentDispatcher(
  env: Record<string, string | undefined> = process.env,
): EgressAgent | undefined {
  const upstreams: string[] = parseEgressUpstreams(env);
  const first: string | undefined = upstreams[0];
  if (first === undefined) return undefined;
  return agentFor(first);
}

/** Close cached agents (tests / shutdown). Clears the map. */
export function closeDispatchers(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const agent of agents.values()) {
    pending.push(agent.close());
  }
  agents.clear();
  return Promise.all(pending).then(() => undefined);
}
