/**
 * TTL cache for the live free-model list.
 *
 * Precedent (omniroute opencode-plugin): modelCacheTtl 300s,
 * autoSyncIntervalMs 300s, minimum poll gap 60s.
 * - TTL: 5min; stale entries are served when upstream fails.
 * - Background refresh: 5min interval.
 * - Min-interval: rapid polls within 60s are clamped (no upstream hit).
 */

import type { NormalizedModel } from "./fetcher.ts";

export const CACHE_TTL_MS = 300_000 as const;
export const REFRESH_INTERVAL_MS = 300_000 as const;
export const MIN_POLL_INTERVAL_MS = 60_000 as const;

export interface RefreshOptions {
  readonly force?: boolean;
  readonly now?: number;
}

export type ModelLoader = () => Promise<readonly NormalizedModel[]>;

export class ModelCache {
  private models: NormalizedModel[] = [];
  private fetchedAt = 0;
  private lastAttemptAt = 0;

  constructor(private readonly load: ModelLoader) {}

  getSnapshot(): readonly NormalizedModel[] {
    return [...this.models];
  }

  getFetchedAt(): number {
    return this.fetchedAt;
  }

  isStale(now: number = Date.now()): boolean {
    if (this.models.length === 0) return true;
    return now - this.fetchedAt >= CACHE_TTL_MS;
  }

  /**
   * Refresh from upstream. Clamps calls inside the 60s min-interval
   * (returns the cached snapshot). On upstream failure serves the stale
   * cache when one exists, otherwise rethrows.
   */
  async refresh(opts?: RefreshOptions): Promise<readonly NormalizedModel[]> {
    const now: number = opts?.now ?? Date.now();
    const force: boolean = opts?.force ?? false;
    if (!force && this.models.length > 0 && now - this.lastAttemptAt < MIN_POLL_INTERVAL_MS) {
      return this.getSnapshot();
    }
    this.lastAttemptAt = now;
    let fresh: readonly NormalizedModel[];
    try {
      fresh = await this.load();
    } catch (err) {
      if (this.models.length > 0) return this.getSnapshot();
      throw err;
    }
    this.models = [...fresh];
    this.fetchedAt = now;
    return this.getSnapshot();
  }

  /**
   * 5min background refresh. Failures are swallowed (stale cache stays).
   * Returns a stop function.
   */
  startBackgroundRefresh(
    intervalMs: number = REFRESH_INTERVAL_MS,
    onUpdate?: (models: readonly NormalizedModel[]) => void,
  ): () => void {
    const timer = setInterval(() => {
      void this.refresh()
        .then((models) => {
          if (onUpdate !== undefined) onUpdate(models);
        })
        .catch(() => {
          // Stale cache stays live; next tick retries.
        });
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }
}
