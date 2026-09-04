/**
 * Autoparser entry: live free-model discovery from upstream.
 * Polls keyless GET https://opencode.ai/zen/v1/models, filters
 * `id.endsWith('-free')` UNION `big-pickle`, caches (5min TTL / 5min
 * background refresh / 60s min-interval), emits RegistryEntry blocks
 * plus gateway catalog dual ids (`oc/<id>` + `<id>`).
 *
 * Upstream is authoritative (liveCatalogAuthoritative). No static lists,
 * no auth/key handling, no gateway/relay/singbox imports — data shapes only.
 */

import {
  CACHE_TTL_MS,
  MIN_POLL_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  ModelCache,
} from "./cache.ts";
import { fetchModels, MODELS_URL } from "./fetcher.ts";
import type { NormalizedModel } from "./fetcher.ts";
import { BIG_PICKLE_ID, filterFreeModels, liveCatalogAuthoritative } from "./filter.ts";
import { toGatewayCatalog, toGatewayCatalogIds, toRegistryEntry } from "./emitter.ts";
import type { GatewayCatalogItem } from "./emitter.ts";
import type { RegistryEntry } from "@/registry/types";

export {
  BIG_PICKLE_ID,
  CACHE_TTL_MS,
  MODELS_URL,
  MIN_POLL_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  fetchModels,
  filterFreeModels,
  liveCatalogAuthoritative,
  toGatewayCatalog,
  toGatewayCatalogIds,
  toRegistryEntry,
};
export type { GatewayCatalogItem, NormalizedModel };

export interface AutoparserOptions {
  readonly fetchFn?: typeof fetch;
  readonly url?: string;
  readonly refreshIntervalMs?: number;
}

export interface Autoparser {
  readonly cache: ModelCache;
  refresh(opts?: { force?: boolean; now?: number }): Promise<readonly NormalizedModel[]>;
  getSnapshot(): readonly NormalizedModel[];
  getRegistryEntry(): RegistryEntry;
  getGatewayCatalogIds(): string[];
  getGatewayCatalog(): GatewayCatalogItem[];
  start(): () => void;
}

/** Live poller wired from fetcher + filter + cache. Keyless only. */
export function createAutoparser(opts?: AutoparserOptions): Autoparser {
  const fetchFn: typeof fetch = opts?.fetchFn ?? fetch;
  const url: string = opts?.url ?? MODELS_URL;
  const intervalMs: number = opts?.refreshIntervalMs ?? REFRESH_INTERVAL_MS;

  const cache = new ModelCache(async () => {
    const models: NormalizedModel[] = await fetchModels({ fetchFn, url });
    return filterFreeModels(models);
  });

  let stop: (() => void) | undefined;

  return {
    cache,
    refresh(o?: { force?: boolean; now?: number }): Promise<readonly NormalizedModel[]> {
      return cache.refresh(o);
    },
    getSnapshot(): readonly NormalizedModel[] {
      return cache.getSnapshot();
    },
    getRegistryEntry(): RegistryEntry {
      return toRegistryEntry(cache.getSnapshot());
    },
    getGatewayCatalogIds(): string[] {
      return toGatewayCatalogIds(cache.getSnapshot());
    },
    getGatewayCatalog(): GatewayCatalogItem[] {
      return toGatewayCatalog(cache.getSnapshot());
    },
    start(): () => void {
      if (stop === undefined) stop = cache.startBackgroundRefresh(intervalMs);
      return () => {
        stop?.();
        stop = undefined;
      };
    },
  };
}
