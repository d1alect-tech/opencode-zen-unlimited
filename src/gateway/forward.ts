/**
 * Format-correct forwarding helpers.
 *
 * - Gateway surface model ids carry the `oc/` prefix; upstream bare ids do
 *   not. Only the prefix is stripped — payloads forward verbatim, no spark
 *   translation.
 * - Route resolution order: registry `targetFormat` > explicit `override` >
 *   inbound shape > `muse-spark-*` prefix default (see `src/registry/types.ts`).
 */

import {
  resolveEffectiveFormat,
  type InboundShape,
  type RegistryModel,
  type TargetFormat,
} from "@/registry/types";
import type { EgressAgent } from "./dispatcher";

export type UpstreamRoute = "/responses" | "/chat/completions";

/**
 * Upstream request init. `Omit`s the DOM `RequestInit.dispatcher` pin so
 * the per-request dispatcher is always an `EgressAgent` from `dispatcher.ts`.
 */
export type UpstreamRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher?: EgressAgent;
};

/** Per-request upstream fetch surface (transports adapt `dispatcher` +
 * `signal`; see `transport.ts` for the node-fetch implementation). */
export type FetchImpl = (
  url: string,
  init: UpstreamRequestInit,
) => Promise<Response>;

export interface ResolveRouteOptions {
  readonly inboundShape?: InboundShape;
  readonly override?: TargetFormat;
  readonly models?: readonly RegistryModel[];
}

/** Strip exactly one leading `oc/` segment. Everything else passes through. */
export function stripOcPrefix(modelId: string): string {
  if (modelId.startsWith("oc/")) return modelId.slice("oc/".length);
  return modelId;
}

function bareId(modelId: string): string {
  const stripped: string = stripOcPrefix(modelId.trim());
  const parts: string[] = stripped.split("/");
  return parts[parts.length - 1] ?? stripped;
}

/** Registry `targetFormat` for a model id (matched on the bare id). */
export function lookupTargetFormat(
  modelId: string,
  models: readonly RegistryModel[] | undefined,
): TargetFormat | undefined {
  if (models === undefined) return undefined;
  const bare: string = bareId(modelId).toLowerCase();
  for (const model of models) {
    if (model.id.toLowerCase() === bare) return model.targetFormat;
  }
  return undefined;
}

/** Resolve the upstream route for a model id. Never throws on unknown ids. */
export function resolveRoute(
  modelId: string,
  options: ResolveRouteOptions = {},
): UpstreamRoute {
  const format = resolveEffectiveFormat({
    modelId: bareId(modelId),
    targetFormat: lookupTargetFormat(modelId, options.models),
    override: options.override,
    inboundShape: options.inboundShape,
  });
  return format === "openai-responses" ? "/responses" : "/chat/completions";
}

/**
 * Streaming decision: explicit `body.stream` wins; otherwise an SSE
 * `Accept` header opts in. Anything else is buffered.
 */
export function wantsStreaming(
  body: unknown,
  accept: string | null,
): boolean {
  if (
    typeof body === "object" &&
    body !== null &&
    "stream" in body &&
    (body as { stream?: unknown }).stream === true
  ) {
    return true;
  }
  return accept !== null && accept.toLowerCase().includes("text/event-stream");
}

/**
 * Parse the inbound JSON body, strip `oc/` from a string `model` field,
 * re-serialize. All other fields pass through byte-identical in value.
 * Non-JSON bodies pass through untouched.
 */
export function rewriteModelBody(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
  if (typeof parsed !== "object" || parsed === null) return rawText;
  const record = parsed as Record<string, unknown>;
  if (typeof record["model"] === "string") {
    return JSON.stringify({
      ...record,
      model: stripOcPrefix(record["model"] as string),
    });
  }
  return rawText;
}

/** Hop-by-hop headers that must never be forwarded 1:1. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/** Copy upstream headers minus hop-by-hop framing (fresh framing applies). */
export function pickForwardHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value: string, key: string) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

/**
 * Bridge a foreign (non-runtime) body stream into a native one.
 *
 * Bun cannot pump an npm-undici `Response.body` when it serves the outer
 * `Response` (headers flush, zero body bytes ever flow). Explicit `read()` +
 * `enqueue()` at the JS level crosses implementations safely because chunks
 * are plain `Uint8Array`. `null` bodies pass through as `null`.
 */
export function bridgeToNativeBody(
  foreign: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  if (foreign === null) return null;
  const reader = foreign.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      let next;
      try {
        next = await reader.read();
      } catch (err) {
        controller.error(err);
        return;
      }
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason): void {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Buffered 1:1 passthrough: upstream status + body + safe headers. */
export async function bufferedPassthrough(
  upstream: Response,
): Promise<Response> {
  const bodyText: string = await upstream.text();
  return new Response(bodyText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: pickForwardHeaders(upstream.headers),
  });
}
