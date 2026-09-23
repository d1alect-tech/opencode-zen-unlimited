/**
 * Egress bench state machine (the pool) for gateway rotation.
 *
 * Pure state, no I/O: bench windows, Retry-After parsing, strike memory,
 * round-robin pick. The fetch/retry loop that drives the pool lives in
 * `./rotation`, which re-exports everything here for existing importers.
 */

/** Default bench window applied on 429/401/403 without usable Retry-After. */
export const DEFAULT_BENCH_MS = 60_000;
/** Cap for honored `Retry-After` values. */
export const MAX_BENCH_MS = 300_000;
/** Second 429 on the same egress inside this window -> long quarantine. */
export const STRIKE_WINDOW_MS = 300_000;
/** Long quarantine for a repeatedly-429 egress (independent per-IP timer). */
export const QUOTA_BENCH_MS = 900_000;
/** Extra random spread added to every bench window. */
export const BENCH_JITTER_MS = 1_000;
/** Long bench for a region-blocked egress (geo-restricted model). */
export const REGION_BENCH_MS = 86_400_000;

/**
 * Region markers in an upstream 403/401 body: Zen rejects geo-restricted
 * models with `RegionError` / "not available in your country". Detecting
 * them separately from request-shaped auth failures keeps the pool alive
 * (one geo-blocked egress must not poison the whole rotation).
 */
export function isRegionBlockedBody(bodyText: string): boolean {
  return (
    bodyText.includes("RegionError") ||
    bodyText.includes("not available in your country") ||
    bodyText.includes("not available in your region")
  );
}

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

/** Per-egress bench state for `zen pool` visibility. */
export interface PoolEgressState {
  readonly egressUrl: string;
  readonly healthy: boolean;
  /** Bench time left in ms (0 when healthy). */
  readonly benchedMsRemaining: number;
}

export interface RotationPool {
  readonly size: number;
  /** Next un-benched egress from the sticky pin; `undefined` when all benched. */
  pick(): string | undefined;
  /** Bench state per egress, in pool order (drives `zen pool`). */
  snapshot(): PoolEgressState[];
  /** Clear all benches plus 429 strike memory; returns benched count. */
  clearBenches(): number;
  /**
   * Lift one egress bench (a 200 proves it healthy — stale benches from
   * transient upstream bursts must not outlive the recovery). Strike
   * memory for that egress goes too, so the next 429 starts at strike one.
   */
  markHealthy(egressUrl: string): void;
  /** Bench an egress for `ms` from now. */
  bench(egressUrl: string, ms: number): void;
  /** Bench expiry timestamp (0 when never benched). */
  benchedUntil(egressUrl: string): number;
  /** Move the pin to the next egress without benching (5xx/timeout path). */
  rotate(): void;
  /**
   * Bench an egress for a 429: honored `Retry-After` (capped) wins;
   * otherwise first strike benches the default window, a repeat strike
   * inside STRIKE_WINDOW_MS quarantines for QUOTA_BENCH_MS.
   * Returns the applied bench duration in ms.
   */
  note429(
    egressUrl: string,
    retryAfter: string | null | undefined,
    nowMs: number,
    random?: () => number,
  ): number;
  /** Record a 2xx through the pool (drives the 5xx bench gate). */
  noteOk(nowMs: number): void;
  /** Timestamp of the last pool 2xx (0 when none yet). */
  lastOkAt(): number;
}

/**
 * Round-robin pool over the healthy egresses: the pin starts at index 0
 * and every `pick()` advances it past the returned egress, so consecutive
 * requests spread across node IPs and per-IP free quota burns evenly
 * instead of concentrating on one egress (sticky pin did that and made
 * single-IP exhaustion the common case). Benched egresses are skipped;
 * shared across requests by the caller so benches persist beyond a
 * single forward.
 */
export function createRotationPool(
  egresses: readonly string[],
  now: () => number = Date.now,
): RotationPool {
  const list: string[] = [...egresses];
  const cooldownUntil = new Map<string, number>();
  const last429At = new Map<string, number>();
  let lastOk = 0;
  let pinnedIdx = 0;
  const isBenched = (egressUrl: string): boolean =>
    (cooldownUntil.get(egressUrl) ?? 0) > now();
  const jitter = (random?: () => number): number =>
    Math.floor((random ?? Math.random)() * (BENCH_JITTER_MS + 1));
  return {
    size: list.length,
    pick(): string | undefined {
      for (let k = 0; k < list.length; k++) {
        const idx: number = (pinnedIdx + k) % list.length;
        const candidate: string | undefined = list[idx];
        if (candidate !== undefined && !isBenched(candidate)) {
          pinnedIdx = (idx + 1) % list.length;
          return candidate;
        }
      }
      return undefined;
    },
    bench(egressUrl: string, ms: number): void {
      cooldownUntil.set(egressUrl, now() + ms);
    },
    snapshot(): PoolEgressState[] {
      const t: number = now();
      return list.map((egressUrl: string): PoolEgressState => {
        const remaining: number = (cooldownUntil.get(egressUrl) ?? 0) - t;
        return {
          egressUrl,
          healthy: remaining <= 0,
          benchedMsRemaining: Math.max(0, remaining),
        };
      });
    },
    clearBenches(): number {
      const t: number = now();
      let benched = 0;
      for (const until of cooldownUntil.values()) {
        if (until > t) benched += 1;
      }
      cooldownUntil.clear();
      last429At.clear();
      return benched;
    },
    markHealthy(egressUrl: string): void {
      cooldownUntil.delete(egressUrl);
      last429At.delete(egressUrl);
    },
    benchedUntil(egressUrl: string): number {
      return cooldownUntil.get(egressUrl) ?? 0;
    },
    rotate(): void {
      if (list.length > 0) pinnedIdx = (pinnedIdx + 1) % list.length;
    },
    note429(
      egressUrl: string,
      retryAfter: string | null | undefined,
      nowMs: number,
      random?: () => number,
    ): number {
      const explicit: number | undefined = parseRetryAfterMs(
        retryAfter,
        nowMs,
      );
      let windowMs: number;
      if (explicit !== undefined) {
        windowMs = explicit;
      } else if (nowMs - (last429At.get(egressUrl) ?? Number.NEGATIVE_INFINITY) <= STRIKE_WINDOW_MS) {
        windowMs = QUOTA_BENCH_MS;
      } else {
        windowMs = DEFAULT_BENCH_MS;
      }
      const applied: number = windowMs + jitter(random);
      cooldownUntil.set(egressUrl, nowMs + applied);
      last429At.set(egressUrl, nowMs);
      return applied;
    },
    noteOk(nowMs: number): void {
      lastOk = nowMs;
    },
    lastOkAt(): number {
      return lastOk;
    },
  };
}
