/**
 * Inline egress rotation + error mapping for the gateway forward path.
 *
 * This is the PRIMARY rotation mechanism (the relay 429-watcher stays as a
 * fallback, it is not deleted). State machine per upstream attempt:
 *
 * - 2xx -> return immediately (provider response, untouched).
 * - 429 -> bench the egress (default 60s; honors `Retry-After`
 *   delay-seconds/http-date, capped, plus jitter), rotate to the next
 *   un-benched egress, retry. At most MAX_ATTEMPTS total tries.
 * - 401/403 -> bench the egress (default window), rotate onward. The same
 *   egress is never retried while benched.
 * - 5xx / network timeout (fetch rejects) -> rotate to the next egress
 *   WITHOUT benching (transient, not quota), retry.
 * - Other 4xx -> return 1:1 immediately, no retry.
 *
 * Error mapping is 1:1: upstream status + body pass through, `x-request-id`
 * preserved. Provenance distinguishes the two 429 sources:
 * - provider 429s keep the provider body (never disguised as gateway-own);
 *   when retries are exhausted the last provider 429 is surfaced, adding a
 *   gateway-computed `retry-after` ONLY if the provider did not set one.
 * - gateway-own 429s (no egress available) carry a synthetic
 *   `gateway_rate_limited` body plus a `retry-after` header.
 *
 * Bench semantics mirror `src/relay/helpers.ts` `createPinnedPicker`
 * (sticky pin, skip-benched pick, cooldown map). Fail-fast: no multi-hour
 * retry loops, at most MAX_ATTEMPTS tries, then the error surfaces.
 */

import type { EgressAgent } from "./dispatcher";
import type { FetchImpl, UpstreamRequestInit } from "./forward";

/** Default bench window applied on 429/401/403 without usable Retry-After. */
export const DEFAULT_BENCH_MS = 60_000;
/** Cap for honored `Retry-After` values. */
export const MAX_BENCH_MS = 300_000;
/** Total upstream tries per client request (initial + retries). */
export const MAX_ATTEMPTS = 5;
/** Extra random spread added to every bench window. */
export const BENCH_JITTER_MS = 1_000;

/**
 * Parse a `Retry-After` header into milliseconds.
 * Accepts delay-seconds or an http-date; returns `undefined` when the
 * value is missing/invalid so the caller falls back to the default.
 * The result is capped at MAX_BENCH_MS.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed: string = value.trim();
  if (trimmed === "") return undefined;
  const seconds: number = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.floor(seconds * 1000), MAX_BENCH_MS);
  }
  const dateMs: number = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - nowMs, 0), MAX_BENCH_MS);
  }
  return undefined;
}

/**
 * Bench window for a failed egress: honored `Retry-After` (capped) or the
 * default window, plus 0..BENCH_JITTER_MS of jitter.
 */
export function benchDurationMs(
  _status: number,
  retryAfter: string | null | undefined,
  nowMs: number = Date.now(),
  random: () => number = Math.random,
): number {
  const base: number =
    parseRetryAfterMs(retryAfter, nowMs) ?? DEFAULT_BENCH_MS;
  return base + Math.floor(random() * (BENCH_JITTER_MS + 1));
}

export interface RotationPool {
  readonly size: number;
  /** Next un-benched egress from the sticky pin; `undefined` when all benched. */
  pick(): string | undefined;
  /** Bench an egress for `ms` from now. */
  bench(egressUrl: string, ms: number): void;
  /** Bench expiry timestamp (0 when never benched). */
  benchedUntil(egressUrl: string): number;
  /** Move the pin to the next egress without benching (5xx/timeout path). */
  rotate(): void;
}

/**
 * Sticky-pin pool mirroring the relay `createPinnedPicker` semantics:
 * the pin starts at index 0 and `pick()` advances it to the first
 * un-benched egress. Shared across requests by the caller so benches
 * persist beyond a single forward.
 */
export function createRotationPool(
  egresses: readonly string[],
  now: () => number = Date.now,
): RotationPool {
  const list: string[] = [...egresses];
  const cooldownUntil = new Map<string, number>();
  let pinnedIdx = 0;
  const isBenched = (egressUrl: string): boolean =>
    (cooldownUntil.get(egressUrl) ?? 0) > now();
  return {
    size: list.length,
    pick(): string | undefined {
      for (let k = 0; k < list.length; k++) {
        const idx: number = (pinnedIdx + k) % list.length;
        const candidate: string | undefined = list[idx];
        if (candidate !== undefined && !isBenched(candidate)) {
          pinnedIdx = idx;
          return candidate;
        }
      }
      return undefined;
    },
    bench(egressUrl: string, ms: number): void {
      cooldownUntil.set(egressUrl, now() + ms);
    },
    benchedUntil(egressUrl: string): number {
      return cooldownUntil.get(egressUrl) ?? 0;
    },
    rotate(): void {
      if (list.length > 0) pinnedIdx = (pinnedIdx + 1) % list.length;
    },
  };
}

/** Where the surfaced response came from. */
export type ErrorProvenance = "provider" | "gateway";

export interface FetchWithRotationOptions {
  readonly fetchImpl: FetchImpl;
  readonly url: string;
  /** Base init (method/headers/body); `signal` + `dispatcher` set per attempt. */
  readonly init: UpstreamRequestInit;
  readonly egresses: readonly string[];
  /** Resolve the per-egress dispatcher; omit for direct (tests). */
  readonly dispatcherFor?: (egressUrl: string) => EgressAgent | undefined;
  readonly clientSignal?: AbortSignal | null;
  /** Shared pool; defaults to a fresh pool (benches last one call). */
  readonly pool?: RotationPool;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly maxAttempts?: number;
}

export interface FetchWithRotationResult {
  readonly res: Response;
  readonly attempts: number;
  readonly egressUrl: string | undefined;
  readonly provenance: ErrorProvenance;
}

/** Seconds until the least-benched egress frees up (min 1). */
function gatewayRetryAfterSec(
  pool: RotationPool,
  egresses: readonly string[],
  nowMs: number,
): number {
  let minMs = Number.POSITIVE_INFINITY;
  for (const egress of egresses) {
    const remaining: number = pool.benchedUntil(egress) - nowMs;
    if (remaining < minMs) minMs = remaining;
  }
  if (!Number.isFinite(minMs) || minMs <= 0) {
    return Math.ceil(DEFAULT_BENCH_MS / 1000);
  }
  return Math.max(1, Math.ceil(minMs / 1000));
}

/** Synthetic gateway-own 429 (provenance: gateway, never provider-shaped). */
function gatewayExhaustedResponse(retryAfterSec: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `All egresses are rate-limited. Add more VPN subscriptions with 'zen add-sub <url>' or wait for reset (retry after ${retryAfterSec} s). See docs/setup-with-ai.md.`,
        type: "gateway_rate_limited",
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "retry-after": String(retryAfterSec),
      },
    },
  );
}

/**
 * Ensure an exhausted provider 429 carries `retry-after` (gateway-computed
 * from bench state) when the provider did not set one. Status, body, and
 * `x-request-id` stay 1:1; the provider body keeps provenance obvious.
 */
function withRetryAfterFallback(
  res: Response,
  retryAfterSec: number,
): Response {
  if (res.headers.get("retry-after") !== null) return res;
  const headers = new Headers(res.headers);
  headers.set("retry-after", String(retryAfterSec));
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Forward with inline bench + rotate + retry. Unlimited parallel (no
 * semaphores); at most `maxAttempts` upstream tries, then the error
 * surfaces. Client aborts propagate and are never retried.
 */
export async function fetchWithRotation(
  options: FetchWithRotationOptions,
): Promise<FetchWithRotationResult> {
  const now: () => number = options.now ?? Date.now;
  const random: () => number = options.random ?? Math.random;
  const maxAttempts: number = options.maxAttempts ?? MAX_ATTEMPTS;
  const pool: RotationPool =
    options.pool ?? createRotationPool(options.egresses, now);

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

  // Direct mode: no egress pool configured -> one attempt, 1:1 mapping.
  if (options.egresses.length === 0) {
    const res: Response = await options.fetchImpl(options.url, {
      ...options.init,
      signal: upstreamController.signal,
      dispatcher: options.init.dispatcher,
    });
    return { res, attempts: 1, egressUrl: undefined, provenance: "provider" };
  }

  let attempts = 0;
  let lastEgress: string | undefined;
  let lastRes: Response | undefined;

  while (attempts < maxAttempts) {
    const egress: string | undefined = pool.pick();
    if (egress === undefined) {
      return {
        res: gatewayExhaustedResponse(
          gatewayRetryAfterSec(pool, options.egresses, now()),
        ),
        attempts,
        egressUrl: lastEgress,
        provenance: "gateway",
      };
    }
    lastEgress = egress;
    const dispatcher: EgressAgent | undefined =
      options.dispatcherFor?.(egress) ?? options.init.dispatcher;

    let res: Response;
    try {
      res = await options.fetchImpl(options.url, {
        ...options.init,
        signal: upstreamController.signal,
        dispatcher,
      });
    } catch (err) {
      if (upstreamController.signal.aborted) throw err;
      attempts += 1;
      pool.rotate();
      if (attempts >= maxAttempts) throw err;
      continue;
    }
    attempts += 1;
    if (res.ok) {
      return { res, attempts, egressUrl: egress, provenance: "provider" };
    }
    if (res.status === 429) {
      pool.bench(
        egress,
        benchDurationMs(429, res.headers.get("retry-after"), now(), random),
      );
      lastRes = res;
      if (attempts >= maxAttempts) break;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      pool.bench(
        egress,
        benchDurationMs(
          res.status,
          res.headers.get("retry-after"),
          now(),
          random,
        ),
      );
      lastRes = res;
      if (attempts >= maxAttempts) break;
      continue;
    }
    if (res.status >= 500) {
      pool.rotate();
      lastRes = res;
      if (attempts >= maxAttempts) break;
      continue;
    }
    return { res, attempts, egressUrl: egress, provenance: "provider" };
  }

  const finalRes: Response | undefined = lastRes;
  if (finalRes === undefined) {
    return {
      res: gatewayExhaustedResponse(
        gatewayRetryAfterSec(pool, options.egresses, now()),
      ),
      attempts,
      egressUrl: lastEgress,
      provenance: "gateway",
    };
  }
  if (finalRes.status === 429) {
    return {
      res: withRetryAfterFallback(
        finalRes,
        gatewayRetryAfterSec(pool, options.egresses, now()),
      ),
      attempts,
      egressUrl: lastEgress,
      provenance: "provider",
    };
  }
  return {
    res: finalRes,
    attempts,
    egressUrl: lastEgress,
    provenance: "provider",
  };
}
