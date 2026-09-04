/**
 * Dual-surface emitter for the free-model list.
 * (a) RegistryEntry model blocks (src/registry/types.ts shapes).
 * (b) Gateway catalog dual ids: every model as `oc/<id>` + `<id>`.
 */

import {
  OC_BASE_URL,
  OC_MODELS_URL,
  defaultFormatForModel,
  toGatewayModelId,
} from "@/registry/types";
import type { RegistryEntry, RegistryModel, TargetFormat } from "@/registry/types";
import type { NormalizedModel } from "./fetcher.ts";

export interface GatewayCatalogItem {
  readonly id: string;
  readonly name: string;
  readonly targetFormat: TargetFormat;
}

const SPARK_CONTEXT_LENGTH = 1_048_576 as const;
const DEFAULT_CONTEXT_LENGTH = 128_000 as const;

function contextLengthFor(id: string): number {
  return defaultFormatForModel(id) === "openai-responses"
    ? SPARK_CONTEXT_LENGTH
    : DEFAULT_CONTEXT_LENGTH;
}

function bareId(id: string): string {
  const trimmed: string = id.trim();
  if (trimmed.startsWith("oc/")) return trimmed.slice("oc/".length);
  return trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
}

/** Free models -> RegistryModel blocks with format routing. */
export function toRegistryModels(models: readonly NormalizedModel[]): RegistryModel[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    targetFormat: defaultFormatForModel(model.id),
    contextLength: contextLengthFor(model.id),
  }));
}

/** Free models -> full oc RegistryEntry for the registry surface. */
export function toRegistryEntry(models: readonly NormalizedModel[]): RegistryEntry {
  return {
    id: "opencode",
    alias: "oc",
    baseUrl: OC_BASE_URL,
    modelsUrl: OC_MODELS_URL,
    models: toRegistryModels(models),
  };
}

/** Every model as dual ids `oc/<id>` + `<id>`, deduped, order-stable. */
export function toGatewayCatalogIds(models: readonly NormalizedModel[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of models) {
    const bare: string = bareId(model.id);
    const prefixed: string = toGatewayModelId(bare);
    for (const id of [prefixed, bare]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Gateway catalog items for both id forms (names + format pinning). */
export function toGatewayCatalog(models: readonly NormalizedModel[]): GatewayCatalogItem[] {
  const out: GatewayCatalogItem[] = [];
  for (const model of models) {
    const bare: string = bareId(model.id);
    const targetFormat: TargetFormat = defaultFormatForModel(bare);
    const prefixed: string = toGatewayModelId(bare);
    out.push({ id: prefixed, name: model.name, targetFormat });
    out.push({ id: bare, name: model.name, targetFormat });
  }
  const seen = new Set<string>();
  return out.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
