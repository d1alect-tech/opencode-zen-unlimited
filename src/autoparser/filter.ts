/**
 * Free-model membership filter. Upstream is authoritative — this module
 * never trusts a static OPENCODE_FREE_MODELS list.
 */

import type { NormalizedModel } from "./fetcher.ts";

export const BIG_PICKLE_ID = "big-pickle" as const;

/** Upstream catalog is the sole source of truth. Never a static list. */
export const liveCatalogAuthoritative = true as const;

/** `big-pickle` UNION `id.endsWith('-free')`. Case-insensitive, trimmed. */
export function isFreeModel(id: string): boolean {
  const trimmed: string = id.trim();
  if (trimmed.length === 0) return false;
  const lower: string = trimmed.toLowerCase();
  if (lower === BIG_PICKLE_ID) return true;
  return lower.endsWith("-free");
}

/** Keep free models only, preserving order and deduping by id. */
export function filterFreeModels(models: readonly NormalizedModel[]): NormalizedModel[] {
  const seen = new Set<string>();
  const out: NormalizedModel[] = [];
  for (const model of models) {
    if (!isFreeModel(model.id)) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}
