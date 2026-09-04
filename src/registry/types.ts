/**
 * Registry types for the `oc` provider binding.
 *
 * Hard contract:
 * - RegistryEntry id is `opencode`, alias is `oc`.
 * - baseUrl is `https://opencode.ai/zen/v1` (upstream Zen, keyless — no auth provider).
 * - Gateway surface exposes models as `oc/<modelId>`.
 *
 * Membership is NEVER decided here: the live free-model list comes from the
 * autoparser poller (`src/autoparser/`). This module is format-only routing.
 */

export type TargetFormat = "openai-responses" | "openai-chat";

export type InboundShape = "responses" | "chat";

export interface RegistryModel {
  readonly id: string;
  readonly name: string;
  readonly targetFormat?: TargetFormat;
  readonly contextLength: number;
}

export interface RegistryEntry {
  readonly id: "opencode";
  readonly alias: "oc";
  readonly baseUrl: "https://opencode.ai/zen/v1";
  readonly modelsUrl: string;
  readonly models: readonly RegistryModel[];
}

export const OC_BASE_URL = "https://opencode.ai/zen/v1" as const;

export const OC_MODELS_URL: string = `${OC_BASE_URL}/models`;

function isTargetFormat(value: string): value is TargetFormat {
  return value === "openai-responses" || value === "openai-chat";
}

/** Parse-don't-validate: unknown input -> TargetFormat or undefined. */
export function parseTargetFormat(value: unknown): TargetFormat | undefined {
  if (typeof value !== "string") return undefined;
  const normalized: string = value.trim().toLowerCase();
  if (isTargetFormat(normalized)) return normalized;
  return undefined;
}

/** Parse-don't-validate: unknown input -> InboundShape or undefined. */
export function parseInboundShape(value: unknown): InboundShape | undefined {
  if (typeof value !== "string") return undefined;
  const normalized: string = value.trim().toLowerCase();
  if (normalized === "responses" || normalized === "openai-responses") return "responses";
  if (normalized === "chat" || normalized === "openai-chat") return "chat";
  return undefined;
}

/**
 * Format-only default: `muse-spark-*` speaks ONLY /responses.
 * Everything else defaults to /chat/completions.
 * This is NOT a membership check — any model id is accepted.
 */
export function defaultFormatForModel(modelId: string): TargetFormat {
  const normalized: string = modelId.trim().toLowerCase();
  const bare: string = normalized.includes("/") ? (normalized.split("/").pop() ?? normalized) : normalized;
  if (bare.startsWith("muse-spark-")) return "openai-responses";
  return "openai-chat";
}

function inboundShapeToFormat(shape: InboundShape): TargetFormat {
  return shape === "responses" ? "openai-responses" : "openai-chat";
}

export interface EffectiveFormatInput {
  readonly modelId: string;
  /** Explicit per-model RegistryModel.targetFormat. Highest precedence. */
  readonly targetFormat?: TargetFormat;
  /** Caller-supplied override. Beats inbound-shape and prefix default. */
  readonly override?: TargetFormat;
  /** Shape of the inbound request. Lowest precedence before prefix default. */
  readonly inboundShape?: InboundShape;
}

/**
 * Resolution order: targetFormat > override > inbound-shape > prefix default.
 */
export function resolveEffectiveFormat(input: EffectiveFormatInput): TargetFormat {
  if (input.targetFormat !== undefined) return input.targetFormat;
  if (input.override !== undefined) return input.override;
  if (input.inboundShape !== undefined) return inboundShapeToFormat(input.inboundShape);
  return defaultFormatForModel(input.modelId);
}

/**
 * Convenience resolver used by the gateway hot path.
 * `override` beats the prefix default.
 */
export function resolveTargetFormat(
  modelId: string,
  override?: TargetFormat,
): TargetFormat {
  return resolveEffectiveFormat({ modelId, override });
}

/** Gateway surface id: always `oc/<bareId>`. Idempotent. */
export function toGatewayModelId(modelId: string): string {
  const trimmed: string = modelId.trim();
  if (trimmed.startsWith("oc/")) return trimmed;
  const bare: string = trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
  return `oc/${bare}`;
}

/** Minimal seed entry. The models array is populated by the autoparser at runtime. */
export const OC_REGISTRY_ENTRY: RegistryEntry = {
  id: "opencode",
  alias: "oc",
  baseUrl: OC_BASE_URL,
  modelsUrl: OC_MODELS_URL,
  models: [
    {
      id: "muse-spark-1.3-contributor-free",
      name: "Muse Spark 1.3 Contributor Free",
      targetFormat: "openai-responses",
      contextLength: 1048576,
    },
  ],
};
