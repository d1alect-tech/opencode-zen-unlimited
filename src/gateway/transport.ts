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

/**
 * Default body inactivity budget (see module doc). Sized for long
generations: big-file edits with reasoning pauses go silent for tens of
 * seconds mid-stream; cutting them kills the client attempt and forces a
 * from-scratch retry. Truly dead egresses still get benched on fire.
 */
export const STALL_TIMEOUT_MS = 120_000;

/**
 * Default headers wait budget: must stay well under the client's own
 * headers timeout (OpenCode gives up at 30s) so rotation can bench a
 * tar-pitted egress and fail over instead of dying with the client.
 */
export const HEADERS_TIMEOUT_MS = 15_000;

/**
 * Resolve the headers budget from env (`HEADERS_TIMEOUT_MS`,
 * milliseconds). Same fallback rule as the stall budget.
 */
export function resolveHeadersTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw: string | undefined = env["HEADERS_TIMEOUT_MS"];
  if (raw === undefined) return HEADERS_TIMEOUT_MS;
  const parsed: number = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return HEADERS_TIMEOUT_MS;
  return parsed;
}

/**
 * Resolve the stall budget from env (`STALL_TIMEOUT_MS`, milliseconds).
 * Unset, non-integer, or non-positive values fall back to the default,
 * so an empty `.env` key means stock behavior.
 */
export function resolveStallTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw: string | undefined = env["STALL_TIMEOUT_MS"];
  if (raw === undefined) return STALL_TIMEOUT_MS;
  const parsed: number = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return STALL_TIMEOUT_MS;
  return parsed;
}

export interface NodeFetchImplOptions {
  readonly stallTimeoutMs?: number;
  readonly headersTimeoutMs?: number;
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
  const headersTimeoutMs: number =
    options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS;
  return async (url: string, init: UpstreamRequestInit): Promise<Response> => {
    const clientSignal: AbortSignal | null | undefined = init.signal;
    const headersController = new AbortController();
    const onClientAbort = (): void => {
      headersController.abort();
    };
    if (clientSignal !== null && clientSignal !== undefined) {
      if (clientSignal.aborted) {
        headersController.abort();
      } else {
        clientSignal.addEventListener("abort", onClientAbort, { once: true });
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let upstream: import("node-fetch").Response;
    try {
      upstream = await Promise.race([
        fetch(url, {
          method: init.method,
          headers: headerRecord(init.headers),
          body: typeof init.body === "string" ? init.body : undefined,
          signal: headersController.signal,
          agent: init.dispatcher,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            headersController.abort();
            reject(
              new Error(
                `upstream headers timed out after ${String(headersTimeoutMs)}ms without response`,
              ),
            );
          }, headersTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (clientSignal !== null && clientSignal !== undefined) {
        clientSignal.removeEventListener("abort", onClientAbort);
      }
    }
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
