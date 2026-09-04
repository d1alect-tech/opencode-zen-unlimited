/**
 * SSE passthrough to the upstream Zen endpoint.
 *
 * - Upstream fetch carries the per-request dispatcher plus an
 *   AbortController linked to the client signal (client abort propagates
 *   upstream).
 * - Non-ok upstream responses map 1:1 (status + body, `x-request-id`
 *   preserved) — they are JSON errors, not streams.
 * - Ok responses pipe `res.body` untouched with SSE framing headers.
 */

import { bufferedPassthrough, type FetchImpl } from "./forward";
import type { EgressAgent } from "./dispatcher";

/** SSE framing headers applied to every ok streaming response. */
export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export interface FetchUpstreamOptions {
  readonly fetchImpl: FetchImpl;
  readonly dispatcher?: EgressAgent;
  readonly clientSignal?: AbortSignal | null;
  readonly method?: string;
}

export interface UpstreamCall {
  readonly res: Response;
  readonly upstreamController: AbortController;
}

/**
 * Fetch upstream with a dedicated AbortController. A client abort
 * (or an already-aborted client signal) aborts the upstream request.
 */
export async function fetchUpstream(
  url: string,
  bodyText: string,
  options: FetchUpstreamOptions,
): Promise<UpstreamCall> {
  const upstreamController = new AbortController();
  const clientSignal: AbortSignal | null | undefined = options.clientSignal;
  if (clientSignal !== null && clientSignal !== undefined) {
    if (clientSignal.aborted) {
      upstreamController.abort();
    } else {
      clientSignal.addEventListener(
        "abort",
        () => {
          upstreamController.abort();
        },
        { once: true },
      );
    }
  }
  const res: Response = await options.fetchImpl(url, {
    method: options.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyText,
    signal: upstreamController.signal,
    dispatcher: options.dispatcher,
  });
  return { res, upstreamController };
}

/**
 * Map an upstream streaming response to the client response:
 * errors go 1:1, ok bodies pipe through with SSE headers
 * (`x-request-id` preserved when present).
 */
export async function toClientSseResponse(
  upstream: Response,
): Promise<Response> {
  if (!upstream.ok) return bufferedPassthrough(upstream);
  const headers = new Headers(SSE_RESPONSE_HEADERS);
  const requestId: string | null = upstream.headers.get("x-request-id");
  if (requestId !== null) headers.set("x-request-id", requestId);
  return new Response(upstream.body, { status: 200, headers });
}
