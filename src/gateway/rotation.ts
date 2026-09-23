/**
 * Inline egress rotation + error mapping for the gateway forward path.
 *
 * This is the PRIMARY rotation mechanism (the relay 429-watcher stays as a
 * fallback, it is not deleted). State machine per upstream attempt:
 *
 * - 2xx -> return immediately (provider response, untouched).
 * - 429 -> two-strike quarantine: first 429 benches the egress for the
 *   default 60s; a second 429 on the same egress within STRIKE_WINDOW_MS
 *   quarantines it for QUOTA_BENCH_MS (provider-side per-IP cooldown is
 *   independent per egress and does not reset at midnight). An explicit
 *   `Retry-After` always wins over both tiers. Then rotate and retry.
 * - 401/403 -> bench the egress (default window), rotate onward. The same
 *   egress is never retried while benched. A SECOND consecutive 401/403
 *   on another egress returns immediately WITHOUT benching: repeating
 *   auth failures are request-shaped (bad model/format), and benching
 *   every egress for a broken request is a self-inflicted pool outage.
 * - 5xx -> bench 30s, but only when another egress recently succeeded
 *   (a global outage must not drain the pool); always rotate and retry.
 * - Network timeout / stall (fetch rejects, client did not abort) -> bench
 *   the egress (default window, no Retry-After exists) and rotate onward.
 *   Only SLOW rejects (at/over DIAL_FAIL_CUTOFF_MS) count toward the
 *   two-consecutive-stall early abort: a fast dial refusal is egress-local
 *   (dead node) and rotating past it is always safe. A body-stalled
 *   egress must not be re-pinned while it recovers.
 * - Other 4xx -> return 1:1 immediately, no retry.
 *
 * Attempts default to one try per pool egress; a per-request deadline
 * (REQUEST_DEADLINE_MS) stops slow chains before the gateway timeout.
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
 *
 * Pool/bench state (windows, Retry-After parsing, strike memory, the
 * round-robin pool itself) lives in `./bench`; this file is the
 * fetch/retry driver on top and re-exports its surface.
 */

import type { EgressAgent } from "./dispatcher";
import { bridgeToNativeBody } from "./forward";
import type { FetchImpl, UpstreamRequestInit } from "./forward";
import {
  BENCH_JITTER_MS,
  benchDurationMs,
  createRotationPool,
  DEFAULT_BENCH_MS,
  isRegionBlockedBody,
  REGION_BENCH_MS,
  type RotationPool,
} from "./bench";

export {
  BENCH_JITTER_MS,
  benchDurationMs,
  createRotationPool,
  DEFAULT_BENCH_MS,
  isRegionBlockedBody,
  MAX_BENCH_MS,
  parseRetryAfterMs,
  QUOTA_BENCH_MS,
  REGION_BENCH_MS,
  STRIKE_WINDOW_MS,
} from "./bench";
export type { PoolEgressState, RotationPool } from "./bench";

/** Total upstream tries per client request (initial + retries).
 *  Legacy fixed cap; the live default is one try per pool egress. */
export const MAX_ATTEMPTS = 5;
/** Per-request deadline for a retry chain (under the 300s gateway timeout). */
export const REQUEST_DEADLINE_MS = 270_000;
/** Consecutive fetch rejects before aborting the request early. */
export const MAX_CONSECUTIVE_TIMEOUTS = 2;
/** Rejects faster than this are dial failures (egress-local), not stalls. */
export const DIAL_FAIL_CUTOFF_MS = 2_000;
/** Short bench for a 5xx egress while the pool is otherwise healthy. */
export const FIVE_XX_BENCH_MS = 30_000;
/** How recent a pool 2xx must be to treat a 5xx as egress-local. */
export const HEALTHY_RECENCY_MS = 300_000;

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

/**
 * Read a Response body as text without consuming the original stream
 * (clone keeps `res` usable for 1:1 error surfacing later). Falls back
 * to "" on any read failure so callers degrade to non-region handling.
 */
async function safeResponseText(res: Response): Promise<string> {
  try {
    const clone = res.clone();
    return await clone.text();
  } catch {
    return "";
  }
}

/** Seconds until the least-benched egress frees up (min 1). */function gatewayRetryAfterSec(
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
        message: `All egresses are rate-limited. Add more VPN subscriptions with 'zen add-sub <url>' or wait for reset (retry after ${retryAfterSec} s). See docs/archive/setup-with-ai.md.`,
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
  return new Response(bridgeToNativeBody(res.body), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Forward with inline bench + rotate + retry. Unlimited parallel (no
 * semaphores); at most `maxAttempts` upstream tries (default: one per
 * pool egress), then the error surfaces. A per-request deadline stops
 * slow chains before the gateway timeout. Client aborts propagate and
 * are never retried.
 */
export async function fetchWithRotation(
  options: FetchWithRotationOptions,
): Promise<FetchWithRotationResult> {
  const now: () => number = options.now ?? Date.now;
  const random: () => number = options.random ?? Math.random;
  const maxAttempts: number =
    options.maxAttempts ?? Math.max(options.egresses.length, 1);
  const startMs: number = now();
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
  let stalls = 0;
  let authFails = 0;
  let optimisticProbes = 0;
  let lastEgress: string | undefined;
  let lastRes: Response | undefined;

  while (attempts < maxAttempts && now() - startMs <= REQUEST_DEADLINE_MS) {
    let egress: string | undefined = pool.pick();
    // When all egresses are benched, allow exactly one optimistic probe
    // of the least-benched one instead of failing instantly with a
    // synthetic 429. Direct probes showed benched egresses often recover
    // well before the 15m quarantine expires (most returned 200 while
    // still benched), and a synthetic 429 makes headroom hang 35s with
    // 0 bytes instead of forwarding. Uncapped probing turns a full-pool
    // 429 into N upstream hits per client request and every re-429
    // re-benches now+15m, so the quarantine self-extends under traffic.
    if (egress === undefined) {
      if (optimisticProbes >= 1) {
        return {
          res: gatewayExhaustedResponse(
            gatewayRetryAfterSec(pool, options.egresses, now()),
          ),
          attempts,
          egressUrl: lastEgress,
          provenance: "gateway",
        };
      }
      let best: string | undefined;
      let bestUntil = Number.POSITIVE_INFINITY;
      for (const cand of options.egresses) {
        const until: number = pool.benchedUntil(cand);
        if (until < bestUntil) {
          bestUntil = until;
          best = cand;
        }
      }
      egress = best;
      optimisticProbes += 1;
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
    }
    lastEgress = egress;
    const dispatcher: EgressAgent | undefined =
      options.dispatcherFor?.(egress) ?? options.init.dispatcher;

    let res: Response;
    const attemptStartMs: number = now();
    try {
      res = await options.fetchImpl(options.url, {
        ...options.init,
        signal: upstreamController.signal,
        dispatcher,
      });
    } catch (err) {
      if (upstreamController.signal.aborted) throw err;
      pool.bench(
        egress,
        benchDurationMs(0, null, now(), random),
      );
      attempts += 1;
      authFails = 0;
      if (now() - attemptStartMs >= DIAL_FAIL_CUTOFF_MS) stalls += 1;
      // No rotate(): pick() already advanced past this egress and the bench
      // above excludes it — rotating again would skip a healthy egress.
      if (stalls >= MAX_CONSECUTIVE_TIMEOUTS) throw err;
      if (attempts >= maxAttempts) throw err;
      continue;
    }
    attempts += 1;
    stalls = 0;
    if (res.ok) {
      pool.noteOk(now());
      pool.markHealthy(egress);
      return { res, attempts, egressUrl: egress, provenance: "provider" };
    }
    if (res.status === 429) {
      authFails = 0;
      pool.note429(egress, res.headers.get("retry-after"), now(), random);
      lastRes = res;
      if (attempts >= maxAttempts) break;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      // Region-blocked model (geo restriction) is egress-local, not
      // request-shaped: bench it for a full day and rotate onward so one
      // bad node can't poison the pool. Only request-shaped auth failures
      // (missing session, bad model) fast-bail on the second hit.
      const bodyText: string = await safeResponseText(res);
      if (isRegionBlockedBody(bodyText)) {
        pool.bench(
          egress,
          REGION_BENCH_MS + Math.floor(random() * (BENCH_JITTER_MS + 1)),
        );
        lastRes = res;
        if (attempts >= maxAttempts) break;
        continue;
      }
      authFails += 1;
      if (authFails >= 2) {
        return { res, attempts, egressUrl: egress, provenance: "provider" };
      }
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
      authFails = 0;
      if (now() - pool.lastOkAt() < HEALTHY_RECENCY_MS) {
        pool.bench(
          egress,
          FIVE_XX_BENCH_MS +
            Math.floor(random() * (BENCH_JITTER_MS + 1)),
        );
      }
      // No rotate(): pick() already advanced past this egress (see above).
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
    if (optimisticProbes >= 1) {
      return {
        res: gatewayExhaustedResponse(
          gatewayRetryAfterSec(pool, options.egresses, now()),
        ),
        attempts,
        egressUrl: lastEgress,
        provenance: "gateway",
      };
    }
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
