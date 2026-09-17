/**
 * Gateway HTTP surface (:20128, Hono).
 *
 * - `POST /v1/chat/completions` / `POST /v1/responses`: verbatim forward to
 *   upstream Zen. Only the `oc/` model prefix is stripped; spark payloads
 *   are NOT translated. The upstream route follows format resolution
 *   (registry `targetFormat` > override > inbound shape).
 * - `POST /v1/messages`: Anthropic-shape passthrough (union-alpha and
 *   friends) to upstream `/zen/v1/messages`. Fixed route, no translation,
 *   only `oc/` stripped; the client `anthropic-version` header is forwarded
 *   when present. Same rotation, benches, and logging as the other routes.
 * - `GET /v1/models`: dual ids (`oc/<id>` + `<id>`) from the registry list
 *   populated by the autoparser at runtime.
 * - `GET /api/health`: liveness.
 * - `GET /api/usage/proxy-logs`: usage log with rotation provenance
 *   (egressUrl, attempts, provenance per request).
 * - `GET /api/pool`: per-egress bench state (`zen pool` visibility).
 * - `POST /api/pool/reset`: clear all benches without a restart.
 *   (`zen pool --reset`; same relief as a restart, minus the downtime).
 * - `GET /api/dashboard/providers/opencode`: keyless provider JSON.
 * - `GET /dashboard/providers/opencode`: minimal HTML page (no framework).
 *
 * Unlimited parallel: no semaphores, no queues. Keyless: no auth injection.
 */

import { Hono, type Context } from "hono";
import {
  createNodeFetchImpl,
  resolveHeadersTimeoutMs,
  resolveStallTimeoutMs,
} from "./transport";
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
  sanitizeResponsesBody,
  stripOcPrefix,
  wantsStreaming,
  type FetchImpl,
  type UpstreamRequestInit,
} from "./forward";
import {
  passthroughSseResponse,
  toClientChatCompletion,
  toClientSseResponse,
} from "./sse";
import { resolveZenApiKey, zenUpstreamHeaders } from "./zen-identity.ts";
import {
  createRotationPool,
  type ErrorProvenance,
  fetchWithRotation,
} from "./rotation";
import { translateChatToResponses } from "./forward";
import { buildOpencodeProvider, renderOpencodePage } from "./dashboard";

export interface ProxyLogEntry {
  readonly ts: string;
  readonly method: string;
  readonly path: UpstreamPath;
  readonly model: string;
  readonly route: string;
  readonly status: number;
  readonly egressUrl: string | undefined;
  readonly attempts: number;
  readonly provenance: ErrorProvenance;
}

export type UpstreamPath =
  | "/v1/chat/completions"
  | "/v1/responses"
  | "/v1/messages";

export interface CreateAppOptions {
  readonly models?: readonly RegistryModel[];
  readonly upstreamBase?: string;
  readonly fetchImpl?: FetchImpl;
  readonly egresses?: readonly string[];
}

const MAX_LOG_ENTRIES = 500;

/**
 * True when the upstream base points at this machine. Loopback upstreams
 * (a local protocol proxy such as Headroom) are dialed direct: pushing
 * 127.0.0.1 through a remote SOCKS/HTTP egress would ask that egress to
 * reach back into this host and fail every attempt. Exported for tests.
 */
export function isLoopbackBase(base: string): boolean {
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  return host.startsWith("127.");
}

function defaultFetchImpl(): FetchImpl {
  return createNodeFetchImpl({
    stallTimeoutMs: resolveStallTimeoutMs(),
    headersTimeoutMs: resolveHeadersTimeoutMs(),
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
    egresses.length === 0 || isLoopbackBase(upstreamBase)
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

  app.get("/api/pool", (c) => {
    const entries = pool.snapshot();
    const healthy = entries.filter((e) => e.healthy).length;
    return c.json({ total: entries.length, healthy, entries }, 200);
  });

  app.post("/api/pool/reset", (c) => {
    const cleared: number = pool.clearBenches();
    return c.json({ reset: true, cleared }, 200);
  });

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
    // Messages-shape traffic (Anthropic API) pins a fixed upstream route:
    // format resolution must not drag it onto /chat/completions.
    const isMessages: boolean = inboundPath === "/v1/messages";
    const route: string = isMessages
      ? "/messages"
      : resolveRoute(model, { inboundShape, models });
    const outgoing: string = isMessages
      ? rewriteModelBody(rawText)
      : route === "/responses" && inboundShape === "chat"
        ? translateChatToResponses(rawText)
        : route === "/responses"
          ? sanitizeResponsesBody(rawText)
          : rewriteModelBody(rawText);
    const anthropicVersion: string | undefined = isMessages
      ? c.req.header("anthropic-version")
      : undefined;
    const {
      res: upstream,
      attempts,
      egressUrl,
      provenance,
    } = await fetchWithRotation({
      fetchImpl,
      url: `${upstreamBase}${route}`,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...zenUpstreamHeaders({ apiKey: resolveZenApiKey() }),
          ...(anthropicVersion === undefined
            ? {}
            : { "anthropic-version": anthropicVersion }),
        },
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
      egressUrl,
      attempts,
      provenance,
    });
    if (logs.length > MAX_LOG_ENTRIES) logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    // Chat-only clients (openai-compatible) need Responses→chat bridging,
    // but only when upstream actually served Responses. Responses-native
    // clients and upstream chat routes pass through verbatim — translating
    // them would corrupt the stream the SDK validates (response.created…).
    const needsChatBridge: boolean =
      route === "/responses" && inboundShape === "chat";
    if (stream) {
      return needsChatBridge
        ? toClientSseResponse(upstream)
        : passthroughSseResponse(upstream);
    }
    return needsChatBridge
      ? toClientChatCompletion(upstream)
      : bufferedPassthrough(upstream);
  };

  app.post("/v1/chat/completions", (c) =>
    handleUpstream(c, "/v1/chat/completions", "chat"),
  );
  app.post("/v1/responses", (c) => handleUpstream(c, "/v1/responses", "responses"));
  // inboundShape is inert on the messages path (fixed upstream route).
  app.post("/v1/messages", (c) => handleUpstream(c, "/v1/messages", "chat"));

  return app;
}
