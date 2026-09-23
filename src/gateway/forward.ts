/**
 * Format-correct forwarding helpers.
 *
 * - Route resolution order: registry `targetFormat` > explicit `override` >
 *   inbound shape > `muse-spark-*` prefix default (see `src/registry/types.ts`).
 * - Response passthrough: `pickForwardHeaders` drops hop-by-hop framing,
 *   `bufferedPassthrough` / `bridgeToNativeBody` cross body streams safely.
 * - Request body rewriting (oc/ strip, sanitize, chat→responses translate)
 *   lives in `./format`; re-exported here so existing imports keep working.
 */

import {
  resolveEffectiveFormat,
  type InboundShape,
  type RegistryModel,
  type TargetFormat,
} from "@/registry/types";
import type { EgressAgent } from "./dispatcher";
import { stripOcPrefix } from "./format";

export {
  rewriteModelBody,
  sanitizeResponsesBody,
  stripOcPrefix,
  translateChatToResponses,
} from "./format";

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

/** Headers that must never be forwarded 1:1: hop-by-hop framing plus
 * `content-encoding` (forwarded bodies are already decoded text — keeping
 * the upstream `br` claim makes clients brotli-decode plain JSON). */
const HOP_BY_HOP = new Set([
  "content-encoding",
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
