/**
 * node-fetch transport for the gateway upstream path.
 *
 * Why not undici: undici's experimental `Socks5ProxyAgent` blackholes
 * streaming response bodies through these egresses (200 headers flush,
 * zero body bytes ever flow, and neither bodyTimeout nor abort unblocks
 * the attempt), while buffered bodies work. `node-fetch` over the mature
 * `socks-proxy-agent` streams reliably through the same ports.
 *
 * Shape:
 * - Implements the shared `FetchImpl` seam. Per-attempt SOCKS agents ride
 *   `init.dispatcher` (supplied by rotation's `dispatcherFor`); the
 *   client abort rides `init.signal`.
 * - Upstream bodies pump into a native `ReadableStream` guarded by an
 *   inactivity watchdog (`stallTimeoutMs`): a stalled body rejects so
 *   rotation benches the egress and fails over instead of hanging.
 */

import fetch from "node-fetch";
import type { FetchImpl, UpstreamRequestInit } from "./forward";

/** Default body inactivity budget (see module doc). */
export const STALL_TIMEOUT_MS = 15_000;

export interface NodeFetchImplOptions {
  readonly stallTimeoutMs?: number;
}

/** Node body surface the pump needs: async bytes plus teardown. */
interface PumpableBody extends AsyncIterable<unknown> {
  destroy?: () => void;
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  return new TextEncoder().encode(String(chunk));
}

function headerRecord(
  headers: UpstreamRequestInit["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === undefined) return out;
  const native = new Headers(headers);
  native.forEach((value: string, key: string) => {
    out[key] = value;
  });
  return out;
}

/**
 * Pump a node body into a native stream. The watchdog arms on
 * construction and re-arms after every chunk; firing destroys the
 * source and errors the stream so the caller fails over.
 */
function pumpBody(
  source: PumpableBody,
  stallTimeoutMs: number,
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    err: unknown,
  ): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    source.destroy?.();
    controller.error(err);
  };
  const arm = (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    timer = setTimeout(() => {
      fail(
        controller,
        new Error(
          `upstream body stalled after ${String(stallTimeoutMs)}ms without bytes`,
        ),
      );
    }, stallTimeoutMs);
  };
  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      arm(controller);
      try {
        for await (const chunk of source) {
          clear();
          controller.enqueue(toBytes(chunk));
          arm(controller);
        }
        clear();
        controller.close();
      } catch (err) {
        fail(controller, err);
      }
    },
    cancel(): void {
      clear();
      source.destroy?.();
    },
  });
}

export function createNodeFetchImpl(
  options: NodeFetchImplOptions = {},
): FetchImpl {
  const stallTimeoutMs: number = options.stallTimeoutMs ?? STALL_TIMEOUT_MS;
  return async (url: string, init: UpstreamRequestInit): Promise<Response> => {
    const upstream = await fetch(url, {
      method: init.method,
      headers: headerRecord(init.headers),
      body: typeof init.body === "string" ? init.body : undefined,
      signal: init.signal ?? undefined,
      agent: init.dispatcher,
    });
    const headers = new Headers();
    upstream.headers.forEach((value: string, key: string) => {
      headers.append(key, value);
    });
    if (upstream.body === null) {
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }
    return new Response(pumpBody(upstream.body, stallTimeoutMs), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  };
}
