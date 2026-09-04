/**
 * Serve entry: gateway on loopback-only 127.0.0.1:PORT (default 20128).
 *
 * - createApp() from src/gateway/app.ts (no semaphores, keyless).
 * - createAutoparser() live free-model poller (5min refresh, best-effort
 *   initial refresh; falls back to static registry seed on failure).
 * - serve() from @hono/node-server, hostname fixed to 127.0.0.1 (F4).
 * - PORT from env, default 20128. No auth (F3 stays tracked issue).
 */

import { serve } from "@hono/node-server";
import { createApp } from "./gateway/app.ts";
import { createAutoparser } from "./autoparser/index.ts";
import { OC_REGISTRY_ENTRY } from "./registry/types.ts";

const PORT: number = Number.parseInt(process.env["PORT"] ?? "20128", 10) || 20128;
const HOST = "127.0.0.1" as const;

const autoparser = createAutoparser();
try {
  await autoparser.refresh();
} catch {
  // Offline/cold start: serve seed registry, background poll fills in.
}
autoparser.start();

const snapshot = autoparser.getSnapshot();
const models = snapshot.length > 0 ? autoparser.getRegistryEntry().models : OC_REGISTRY_ENTRY.models;
const app = createApp({ models });

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`gateway listening on http://${HOST}:${info.port}`);
});
