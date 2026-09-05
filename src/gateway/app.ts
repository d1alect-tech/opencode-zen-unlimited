/**
 * Gateway HTTP surface (:20128, Hono).
 *
 * - `POST /v1/chat/completions` / `POST /v1/responses`: verbatim forward to
 *   upstream Zen. Only the `oc/` model prefix is stripped; spark payloads
 *   are NOT translated. The upstream route follows format resolution
 *   (registry `targetFormat` > override > inbound shape).
 * - `GET /v1/models`: dual ids (`oc/<id>` + `<id>`) from the registry list
 *   populated by the autoparser at runtime.
 * - `GET /api/health`: liveness.
 * - `GET /api/usage/proxy-logs`: watcher-compat minimal usage log.
 * - `GET /api/dashboard/providers/opencode`: keyless provider JSON.
 * - `GET /dashboard/providers/opencode`: minimal HTML page (no framework).
 *
 * Unlimited parallel: no semaphores, no queues. Keyless: no auth injection.
 */

import { Hono, type Context } from "hono";
import { createNodeFetchImpl, resolveStallTimeoutMs } from "./transport";
import {
  OC_BASE_URL,
  OC_REGISTRY_ENTRY,
  toGatewayModelId,
  type InboundShape,
  type RegistryModel,
} from "@/registry/types";
import {
  agentFor,
  parseEgressUpstreams,
  type EgressAgent,
} from "./dispatcher";
import {
  bufferedPassthrough,
  resolveRoute,
  rewriteModelBody,
  stripOcPrefix,
  wantsStreaming,
  type FetchImpl,
  type UpstreamRequestInit,
} from "./forward";
import { toClientSseResponse } from "./sse";
import { createRotationPool, fetchWithRotation } from "./rotation";
import { buildOpencodeProvider, renderOpencodePage } from "./dashboard";

export interface ProxyLogEntry {
  readonly ts: string;
  readonly method: string;
  readonly path: UpstreamPath;
  readonly model: string;
  readonly route: string;
  readonly status: number;
}

export type UpstreamPath = "/v1/chat/completions" | "/v1/responses";

export interface CreateAppOptions {
  readonly models?: readonly RegistryModel[];
  readonly upstreamBase?: string;
  readonly fetchImpl?: FetchImpl;
  readonly egresses?: readonly string[];
}

const MAX_LOG_ENTRIES = 500;

function defaultFetchImpl(): FetchImpl {
  return createNodeFetchImpl({
    stallTimeoutMs: resolveStallTimeoutMs(),
  });
}

function parseModel(rawText: string): string {
  try {
    const parsed: unknown = JSON.parse(rawText) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const model: unknown = (parsed as Record<string, unknown>)["model"];
      if (typeof model === "string") return model;
    }
  } catch {
    // Non-JSON bodies forward verbatim with an empty model label.
  }
  return "";
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const models: readonly RegistryModel[] =
    options.models ?? OC_REGISTRY_ENTRY.models;
  const upstreamBase: string = options.upstreamBase ?? OC_BASE_URL;
  const fetchImpl: FetchImpl = options.fetchImpl ?? defaultFetchImpl();
  const egresses: readonly string[] =
    options.egresses ?? parseEgressUpstreams();
  const pool = createRotationPool(egresses);
  const dispatcherFor =
    egresses.length === 0
      ? undefined
      : (egressUrl: string): EgressAgent => agentFor(egressUrl);
  const logs: ProxyLogEntry[] = [];

  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }, 200));

  app.get("/v1/models", (c) => {
    const data: { id: string; object: string; owned_by: string }[] = [];
    for (const model of models) {
      const bare: string = stripOcPrefix(model.id);
      data.push(
        { id: toGatewayModelId(bare), object: "model", owned_by: "oc" },
        { id: bare, object: "model", owned_by: "oc" },
      );
    }
    return c.json({ object: "list", data }, 200);
  });

  app.get("/api/usage/proxy-logs", (c) =>
    c.json({ logs: [...logs], total: logs.length }, 200),
  );

  app.get("/api/dashboard/providers/opencode", (c) =>
    c.json(buildOpencodeProvider(models), 200),
  );

  app.get("/dashboard/providers/opencode", (c) =>
    c.html(renderOpencodePage(buildOpencodeProvider(models)), 200),
  );

  const handleUpstream = async (
    c: Context,
    inboundPath: UpstreamPath,
    inboundShape: InboundShape,
  ): Promise<Response> => {
    const rawText: string = await c.req.text();
    const model: string = parseModel(rawText);
    let parsedBody: unknown = {};
    try {
      parsedBody = JSON.parse(rawText) as unknown;
    } catch {
      parsedBody = {};
    }
    const stream: boolean = wantsStreaming(
      parsedBody,
      c.req.header("accept") ?? null,
    );
    const route = resolveRoute(model, { inboundShape, models });
    const outgoing: string = rewriteModelBody(rawText);
    const { res: upstream } = await fetchWithRotation({
      fetchImpl,
      url: `${upstreamBase}${route}`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: outgoing,
      },
      egresses,
      pool,
      dispatcherFor,
      clientSignal: c.req.raw.signal,
    });
    logs.push({
      ts: new Date().toISOString(),
      method: "POST",
      path: inboundPath,
      model,
      route,
      status: upstream.status,
    });
    if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    if (stream) return toClientSseResponse(upstream);
    return bufferedPassthrough(upstream);
  };

  app.post("/v1/chat/completions", (c) =>
    handleUpstream(c, "/v1/chat/completions", "chat"),
  );
  app.post("/v1/responses", (c) => handleUpstream(c, "/v1/responses", "responses"));

  return app;
}
