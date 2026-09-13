/**
 * Format-correct forwarding helpers.
 *
 * - Gateway surface model ids carry the `oc/` prefix; upstream bare ids do
 *   not. Only the prefix is stripped — payloads forward verbatim, no spark
 *   translation.
 * - Route resolution order: registry `targetFormat` > explicit `override` >
 *   inbound shape > `muse-spark-*` prefix default (see `src/registry/types.ts`).
 */

import {
  resolveEffectiveFormat,
  type InboundShape,
  type RegistryModel,
  type TargetFormat,
} from "@/registry/types";
import type { EgressAgent } from "./dispatcher";

export type UpstreamRoute = "/responses" | "/chat/completions";

/**
 * Upstream request init. `Omit`s the DOM `RequestInit.dispatcher` pin so
 * the per-request dispatcher is always an `EgressAgent` from `dispatcher.ts`.
 */
export type UpstreamRequestInit = Omit<RequestInit, "dispatcher"> & {
  readonly dispatcher?: EgressAgent;
};

/** Per-request upstream fetch surface (transports adapt `dispatcher` +
 * `signal`; see `transport.ts` for the node-fetch implementation). */
export type FetchImpl = (
  url: string,
  init: UpstreamRequestInit,
) => Promise<Response>;

export interface ResolveRouteOptions {
  readonly inboundShape?: InboundShape;
  readonly override?: TargetFormat;
  readonly models?: readonly RegistryModel[];
}

/** Strip exactly one leading `oc/` segment. Everything else passes through. */
export function stripOcPrefix(modelId: string): string {
  if (modelId.startsWith("oc/")) return modelId.slice("oc/".length);
  return modelId;
}

function bareId(modelId: string): string {
  const stripped: string = stripOcPrefix(modelId.trim());
  const parts: string[] = stripped.split("/");
  return parts[parts.length - 1] ?? stripped;
}

/** Registry `targetFormat` for a model id (matched on the bare id). */
export function lookupTargetFormat(
  modelId: string,
  models: readonly RegistryModel[] | undefined,
): TargetFormat | undefined {
  if (models === undefined) return undefined;
  const bare: string = bareId(modelId).toLowerCase();
  for (const model of models) {
    if (model.id.toLowerCase() === bare) return model.targetFormat;
  }
  return undefined;
}

/** Resolve the upstream route for a model id. Never throws on unknown ids. */
export function resolveRoute(
  modelId: string,
  options: ResolveRouteOptions = {},
): UpstreamRoute {
  const format = resolveEffectiveFormat({
    modelId: bareId(modelId),
    targetFormat: lookupTargetFormat(modelId, options.models),
    override: options.override,
    inboundShape: options.inboundShape,
  });
  return format === "openai-responses" ? "/responses" : "/chat/completions";
}

/**
 * Streaming decision: explicit `body.stream` wins; otherwise an SSE
 * `Accept` header opts in. Anything else is buffered.
 */
export function wantsStreaming(
  body: unknown,
  accept: string | null,
): boolean {
  if (
    typeof body === "object" &&
    body !== null &&
    "stream" in body &&
    (body as { stream?: unknown }).stream === true
  ) {
    return true;
  }
  return accept !== null && accept.toLowerCase().includes("text/event-stream");
}

/**
 * Parse the inbound JSON body, strip `oc/` from a string `model` field,
 * re-serialize. All other fields pass through byte-identical in value.
 * Non-JSON bodies pass through untouched.
 */
export function rewriteModelBody(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
  if (typeof parsed !== "object" || parsed === null) return rawText;
  const record = parsed as Record<string, unknown>;
  if (typeof record["model"] === "string") {
    return JSON.stringify({
      ...record,
      model: stripOcPrefix(record["model"] as string),
    });
  }
  return rawText;
}

/**
 * Sanitize a Responses request body for upstream forward.
 *
 * Root cause for `reasoning encrypted_content was not issued to this caller`:
 * reasoning items (id + encrypted_content) are bound to the egress IP/key
 * that issued them. The pool rotates egresses, so replaying a previous
 * turn's reasoning block through a new egress is rejected. Omitting them
 * is always legal — upstream just re-reasons (extra tokens, never an error).
 * Same for `previous_response_id` (server-side state of another egress).
 * Everything else passes through; only the `oc/` model prefix is stripped.
 * Non-JSON bodies pass through untouched.
 */
export function sanitizeResponsesBody(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
  if (typeof parsed !== "object" || parsed === null) return rawText;
  const record = parsed as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  if (typeof record["model"] === "string") {
    out["model"] = stripOcPrefix(record["model"] as string);
  }
  if (Array.isArray(record["input"])) {
    out["input"] = (record["input"] as unknown[]).filter((item) => {
      if (typeof item !== "object" || item === null) return true;
      return (item as Record<string, unknown>)["type"] !== "reasoning";
    });
  }
  delete out["previous_response_id"];
  return JSON.stringify(out);
}

/**
 * Upstream Responses API rejects the vendor `max` effort (verified 400;
 * `minimal`..`xhigh` pass). Map `max` down to `xhigh` and say so.
 */
function mapReasoningEffort(effort: unknown): string | undefined {
  if (typeof effort !== "string" || effort === "") return undefined;
  return effort === "max" ? "xhigh" : effort;
}

/** Map one chat content part to a Responses input part; undefined drops. */
function mapContentPart(
  part: unknown,
): Record<string, unknown> | undefined {
  if (typeof part === "string") return { type: "input_text", text: part };
  if (typeof part !== "object" || part === null) return undefined;
  const rec = part as Record<string, unknown>;
  if (rec["type"] === "text" && typeof rec["text"] === "string") {
    return { type: "input_text", text: rec["text"] };
  }
  if (rec["type"] === "image_url") {
    return { type: "input_image", image_url: rec["image_url"] };
  }
  return undefined;
}

/** Map one chat message to Responses input items (1:N for tool calls). */
function mapChatMessage(
  msg: unknown,
): Record<string, unknown>[] {
  if (typeof msg !== "object" || msg === null) return [];
  const rec = msg as Record<string, unknown>;
  const role = rec["role"];
  if (role === "tool") {
    if (typeof rec["tool_call_id"] !== "string") return [];
    return [
      {
        type: "function_call_output",
        call_id: rec["tool_call_id"],
        output: typeof rec["content"] === "string" ? rec["content"] : "",
      },
    ];
  }
  if (role === "assistant") {
    const out: Record<string, unknown>[] = [];
    const calls = rec["tool_calls"];
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (typeof call !== "object" || call === null) continue;
        const crec = call as Record<string, unknown>;
        const fn =
          typeof crec["function"] === "object" && crec["function"] !== null
            ? (crec["function"] as Record<string, unknown>)
            : {};
        if (typeof crec["id"] !== "string") continue;
        out.push({
          type: "function_call",
          call_id: crec["id"],
          name: typeof fn["name"] === "string" ? fn["name"] : "",
          arguments:
            typeof fn["arguments"] === "string" ? fn["arguments"] : "{}",
        });
      }
    }
    const content = rec["content"];
    if (typeof content === "string" && content !== "") {
      out.push({ role: "assistant", content });
    }
    return out;
  }
  if (role === "system" || role === "user" || role === "developer") {
    const content = rec["content"];
    if (typeof content === "string") return [{ role, content }];
    if (Array.isArray(content)) {
      const parts: Record<string, unknown>[] = [];
      for (const part of content) {
        const mapped = mapContentPart(part);
        if (mapped !== undefined) parts.push(mapped);
      }
      return [{ role, content: parts }];
    }
  }
  return [];
}

/** Map a chat function tool to a Responses function tool. */
function mapChatTool(tool: unknown): Record<string, unknown> | undefined {
  if (typeof tool !== "object" || tool === null) return undefined;
  const rec = tool as Record<string, unknown>;
  if (rec["type"] !== "function") return undefined;
  const fn =
    typeof rec["function"] === "object" && rec["function"] !== null
      ? (rec["function"] as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = { type: "function" };
  if (typeof fn["name"] === "string") out["name"] = fn["name"];
  if (typeof fn["description"] === "string") {
    out["description"] = fn["description"];
  }
  if (typeof fn["parameters"] === "object" && fn["parameters"] !== null) {
    out["parameters"] = fn["parameters"];
  }
  return out;
}

/**
 * Translate a chat/completions request body to the Responses shape.
 * The gateway routes spark models to upstream `/responses` by
 * `targetFormat`, but OpenCode (openai-compatible provider) only speaks
 * chat — without translation Zen 400s on `unknown parameter \u2018messages\u2019`
 * (measured). Allowlist translation: only verified-safe fields cross.
 * Non-JSON input passes through untouched.
 */
export function translateChatToResponses(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return rawText;
  }
  if (typeof parsed !== "object" || parsed === null) return rawText;
  const body = parsed as Record<string, unknown>;
  if (!Array.isArray(body["messages"])) return rewriteModelBody(rawText);
  const out: Record<string, unknown> = {};
  if (typeof body["model"] === "string") {
    out["model"] = stripOcPrefix(body["model"]);
  }
  const input: Record<string, unknown>[] = [];
  for (const msg of body["messages"] as unknown[]) {
    input.push(...mapChatMessage(msg));
  }
  out["input"] = input;
  const effort = mapReasoningEffort(body["reasoning_effort"]);
  if (effort !== undefined) {
    out["reasoning"] = { effort, summary: "auto" };
  }
  if (Array.isArray(body["tools"])) {
    const tools: Record<string, unknown>[] = [];
    for (const tool of body["tools"] as unknown[]) {
      const mapped = mapChatTool(tool);
      if (mapped !== undefined) tools.push(mapped);
    }
    if (tools.length > 0) out["tools"] = tools;
  }
  const choice = body["tool_choice"];
  if (choice === "auto" || choice === "none" || choice === "required") {
    out["tool_choice"] = choice;
  } else if (typeof choice === "object" && choice !== null) {
    const crec = choice as Record<string, unknown>;
    const fn =
      typeof crec["function"] === "object" && crec["function"] !== null
        ? (crec["function"] as Record<string, unknown>)
        : undefined;
    const name =
      typeof crec["name"] === "string"
        ? crec["name"]
        : typeof fn?.["name"] === "string"
          ? fn["name"]
          : undefined;
    if (name !== undefined) out["tool_choice"] = { type: "function", name };
  }
  if (typeof body["stream"] === "boolean") out["stream"] = body["stream"];
  if (typeof body["temperature"] === "number") {
    out["temperature"] = body["temperature"];
  }
  if (typeof body["top_p"] === "number") out["top_p"] = body["top_p"];
  if (typeof body["max_tokens"] === "number") {
    out["max_output_tokens"] = body["max_tokens"];
  }
  return JSON.stringify(out);
}

/** Hop-by-hop headers that must never be forwarded 1:1. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/** Copy upstream headers minus hop-by-hop framing (fresh framing applies). */
export function pickForwardHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value: string, key: string) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

/**
 * Bridge a foreign (non-runtime) body stream into a native one.
 *
 * Bun cannot pump an npm-undici `Response.body` when it serves the outer
 * `Response` (headers flush, zero body bytes ever flow). Explicit `read()` +
 * `enqueue()` at the JS level crosses implementations safely because chunks
 * are plain `Uint8Array`. `null` bodies pass through as `null`.
 */
export function bridgeToNativeBody(
  foreign: ReadableStream<Uint8Array> | null,
): ReadableStream<Uint8Array> | null {
  if (foreign === null) return null;
  const reader = foreign.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      let next;
      try {
        next = await reader.read();
      } catch (err) {
        controller.error(err);
        return;
      }
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason): void {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

/** Buffered 1:1 passthrough: upstream status + body + safe headers. */
export async function bufferedPassthrough(
  upstream: Response,
): Promise<Response> {
  const bodyText: string = await upstream.text();
  return new Response(bodyText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: pickForwardHeaders(upstream.headers),
  });
}
