/**
 * Serve boot choke point (T8 gate + T1 zero-args default).
 *
 * Single entry for every serve path: the zero-args default in
 * `src/index.ts` and the `serve` CLI subcommand both land here, so the
 * no-egress gate cannot be bypassed by taking the other path.
 * Non-serve commands (doctor/status/logs/...) never call this module.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createAutoparser } from "../autoparser/index.ts";
import { OC_REGISTRY_ENTRY } from "../registry/types.ts";
import { parseEgressUpstreams } from "./dispatcher.ts";
import {
  DIRECT_MODE_WARNING,
  evaluateEgressGate,
  NO_EGRESS_MESSAGE,
  type EgressGateDecision,
} from "./egress-gate.ts";

/** Pure gate check over env+argv (test seam; no side effects). */
export function checkServeGate(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): EgressGateDecision {
  return evaluateEgressGate(parseEgressUpstreams(env), argv);
}

/**
 * Boot the gateway. Applies the no-egress gate first:
 * - empty EGRESS_UPSTREAMS without --no-egress-direct -> stderr + return 1.
 * - empty with the flag -> loud warning, serve direct.
 * Resolves 1 on refusal; otherwise the returned promise never settles,
 * so entry-point process.exit() calls cannot kill the listener.
 */
export async function startServe(argv: readonly string[]): Promise<number> {
  const decision: EgressGateDecision = checkServeGate(process.env, argv);
  if (!decision.allowed) {
    console.error(NO_EGRESS_MESSAGE);
    return 1;
  }
  if (decision.direct) {
    console.warn(DIRECT_MODE_WARNING);
  }

  const PORT: number =
    Number.parseInt(process.env["PORT"] ?? "20128", 10) || 20128;
  const HOST = "127.0.0.1" as const;

  const autoparser = createAutoparser();
  try {
    await autoparser.refresh();
  } catch {
    // Offline/cold start: serve seed registry, background poll fills in.
  }
  autoparser.start();

  const snapshot = autoparser.getSnapshot();
  const models =
    snapshot.length > 0 ? autoparser.getRegistryEntry().models : OC_REGISTRY_ENTRY.models;
  const app = createApp({ models });

  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`gateway listening on http://${HOST}:${info.port}`);
  });
  // Never settle: serve() is non-blocking, and every entry point
  // (src/index.ts) calls process.exit(await ...) after we return —
  // returning here would instantly kill the freshly-bound listener.
  return new Promise<never>(() => {});
}
