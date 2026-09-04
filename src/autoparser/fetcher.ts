/**
 * Keyless upstream fetcher for the live free-model catalog.
 *
 * Upstream is authoritative: GET https://opencode.ai/zen/v1/models
 * with NO auth headers. Handles `{ data: [] }` envelopes and bare arrays,
 * normalizing id/modelId/model_id + name/displayName/display_name fields.
 */

export const MODELS_URL = "https://opencode.ai/zen/v1/models" as const;

export interface NormalizedModel {
  readonly id: string;
  readonly name: string;
}

function readStringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === "string") {
      const trimmed: string = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

/** Parse-don't-validate: unknown entry -> NormalizedModel or undefined. */
export function normalizeModel(raw: unknown): NormalizedModel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record: Record<string, unknown> = raw as Record<string, unknown>;
  const id: string | undefined = readStringField(record, ["id", "modelId", "model_id"]);
  if (id === undefined) return undefined;
  const name: string = readStringField(record, ["name", "displayName", "display_name"]) ?? id;
  return { id, name };
}

/** Parse-don't-validate: unknown payload -> NormalizedModel[] (drops invalid). */
export function normalizePayload(payload: unknown): NormalizedModel[] {
  let items: unknown[] | undefined;
  if (Array.isArray(payload)) {
    items = payload;
  } else if (typeof payload === "object" && payload !== null) {
    const record: Record<string, unknown> = payload as Record<string, unknown>;
    const data: unknown = record["data"];
    if (Array.isArray(data)) items = data;
  }
  if (items === undefined) return [];
  const out: NormalizedModel[] = [];
  for (const item of items) {
    const model: NormalizedModel | undefined = normalizeModel(item);
    if (model !== undefined) out.push(model);
  }
  return out;
}

export interface FetchModelsOptions {
  readonly fetchFn?: typeof fetch;
  readonly url?: string;
}

/**
 * Keyless GET of the upstream catalog. Sends no Authorization / api-key
 * headers — the Zen models endpoint is public.
 */
export async function fetchModels(opts?: FetchModelsOptions): Promise<NormalizedModel[]> {
  const fetchFn: typeof fetch = opts?.fetchFn ?? fetch;
  const url: string = opts?.url ?? MODELS_URL;
  const res: Response = await fetchFn(url, { method: "GET" });
  if (!res.ok) throw new Error(`models fetch failed: ${res.status} ${url}`);
  const payload: unknown = (await res.json()) as unknown;
  return normalizePayload(payload);
}
