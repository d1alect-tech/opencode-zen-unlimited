/**
 * Per-egress proxy agent map for the gateway hot path.
 *
 * Rules:
 * - One cached agent per egress URL. `socks5h://` (hostname resolved
 *   remotely) is normalized to `socks5://`; SOCKS5 resolves domain names
 *   server-side by default, so semantics are preserved.
 * - SOCKS agents come from `socks-proxy-agent` (mature SOCKS stack):
 *   undici's experimental `Socks5ProxyAgent` blackholes streaming response
 *   bodies through these egresses, while `node-fetch` over
 *   `socks-proxy-agent` streams reliably (see `src/gateway/transport.ts`).
 * - HTTP(S) agents (`http://` / `https://` purchased proxies) come from
 *   `./http-proxy-agent.ts` (agent-base CONNECT + absolute-URI forwarding):
 *   `node-fetch` accepts any `http.Agent` through the `FetchImpl`
 *   dispatcher seam, so `transport.ts` is untouched.
 * - `keepAlive: false`: fresh TCP+TLS per request. The pool nodes flap;
 *   reusing pooled sockets through them risks stale-connection stalls.
 *   The handshake costs ~1s against multi-second upstream latency.
 * - No globals are touched: agents travel per-request through the
 *   `FetchImpl` seam, never via a default dispatcher.
 */

import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpProxyAgent } from "./http-proxy-agent.ts";

export type EgressAgent = SocksProxyAgent | HttpProxyAgent;

/** Proxy schemes the gateway can egress through (SOCKS pool + HTTP(S)). */
export const PROXY_SCHEMES: ReadonlySet<string> = new Set([
  "socks5",
  "socks",
  "socks4",
  "socks4a",
  "http",
  "https",
]);

const agents = new Map<string, EgressAgent>();

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

/** Build (or reuse the cached) agent for one egress URL. */
export function agentFor(egressUrl: string): EgressAgent {
  const target: string = egressUrl.replace(/^socks5h:\/\//i, "socks5://");
  const scheme: string = target.split("://")[0]?.toLowerCase() ?? "";
  if (!PROXY_SCHEMES.has(scheme)) {
    throw new Error(
      `agentFor: SOCKS proxy URL (or http/https proxy URL) required, got: ${egressUrl}`,
    );
  }
  const cached: EgressAgent | undefined = agents.get(target);
  if (cached !== undefined) return cached;
  if (scheme === "http" || scheme === "https") {
    const httpAgent: HttpProxyAgent = new HttpProxyAgent(target, {
      keepAlive: false,
    });
    agents.set(target, httpAgent);
    return httpAgent;
  }
  const agent: EgressAgent = new SocksProxyAgent(target, {
    keepAlive: false,
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

/** Destroy cached agents (tests / shutdown). Clears the map. */
export function closeDispatchers(): void {
  for (const agent of agents.values()) {
    agent.destroy();
  }
  agents.clear();
}
