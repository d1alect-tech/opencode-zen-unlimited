/**
 * SSE handling toward the upstream Zen endpoint.
 *
 * - Upstream fetch carries the per-request dispatcher plus an
 *   AbortController linked to the client signal (client abort propagates
 *   upstream).
 * - Non-ok upstream responses map 1:1 (status + body, `x-request-id`
 *   preserved) — they are JSON errors, not streams.
 * - Ok streams take one of two paths: Responses-native clients
 *   (`passthroughSseResponse`) get upstream bytes untouched; chat-only
 *   clients (`toClientSseResponse`) get Responses events translated to
 *   chat chunks. The caller picks by inbound shape + upstream route.
 */

import { bridgeToNativeBody, bufferedPassthrough, type FetchImpl } from "./forward";
import { resolveZenApiKey, zenUpstreamHeaders } from "./zen-identity.ts";
import type { EgressAgent } from "./dispatcher";

/** SSE framing headers applied to every ok streaming response. */
export const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export interface FetchUpstreamOptions {
  readonly fetchImpl: FetchImpl;
  readonly dispatcher?: EgressAgent;
  readonly clientSignal?: AbortSignal | null;
  readonly method?: string;
}

export interface UpstreamCall {
  readonly res: Response;
  readonly upstreamController: AbortController;
}

/**
 * Fetch upstream with a dedicated AbortController. A client abort
 * (or an already-aborted client signal) aborts the upstream request.
 */
export async function fetchUpstream(
  url: string,
  bodyText: string,
  options: FetchUpstreamOptions,
): Promise<UpstreamCall> {
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
  const res: Response = await options.fetchImpl(url, {
    method: options.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      ...zenUpstreamHeaders({ apiKey: resolveZenApiKey() }),
    },
    body: bodyText,
    signal: upstreamController.signal,
    dispatcher: options.dispatcher,
  });
  return { res, upstreamController };
}

/**
 * Map an upstream Responses-API SSE stream to Chat-Completions chunks.
 * The openai-compatible client only understands `choices[].delta` +
 * `[DONE]`; raw Responses events (`response.output_text.delta`, …)
 * yield zero content client-side, which surfaces as
 * "failed to send a message" after all-200 retries. Unknown events
 * (reasoning deltas, …) drop; the stream always ends with `[DONE]`.
 */
function responsesToChatTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let roleSent = false;
  let doneSent = false;
  let respId = "chatcmpl-zen";
  let model = "zen";
  const created: number = Math.floor(Date.now() / 1000);
  const callIds: string[] = [];
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    text: string,
  ): void => {
    controller.enqueue(encoder.encode(text));
  };
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null,
  ): string =>
    "data: " +
    JSON.stringify({
      id: respId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n";
  const ensureRole = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (!roleSent) {
      roleSent = true;
      emit(controller, chunk({ role: "assistant" }, null));
    }
  };
  const sendDone = (
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    if (!doneSent) {
      doneSent = true;
      emit(controller, "data: [DONE]\n\n");
    }
  };
  const handleFrame = (
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    let event = "";
    const datas: string[] = [];
    for (const rawLine of frame.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) datas.push(line.slice(5).trim());
    }
    for (const data of datas) {
      if (data === "[DONE]") {
        sendDone(controller);
        return;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type: string =
        typeof obj["type"] === "string" ? (obj["type"] as string) : event;
      if (type === "response.created") {
        const r =
          typeof obj["response"] === "object" && obj["response"] !== null
            ? (obj["response"] as Record<string, unknown>)
            : {};
        if (typeof r["id"] === "string") respId = `chatcmpl-${r["id"]}`;
        if (typeof r["model"] === "string") model = r["model"];
      } else if (type === "response.output_text.delta") {
        if (typeof obj["delta"] === "string" && obj["delta"] !== "") {
          ensureRole(controller);
          emit(controller, chunk({ content: obj["delta"] }, null));
        }
      } else if (type === "response.output_item.added") {
        const item =
          typeof obj["item"] === "object" && obj["item"] !== null
            ? (obj["item"] as Record<string, unknown>)
            : {};
        if (
          item["type"] === "function_call" &&
          typeof item["call_id"] === "string"
        ) {
          let idx = callIds.indexOf(item["call_id"]);
          if (idx === -1) {
            callIds.push(item["call_id"]);
            idx = callIds.length - 1;
          }
          ensureRole(controller);
          emit(controller, chunk({
            tool_calls: [{
              index: idx,
              id: item["call_id"],
              type: "function",
              function: {
                name: typeof item["name"] === "string" ? item["name"] : "",
                arguments:
                  typeof item["arguments"] === "string"
                    ? item["arguments"]
                    : "",
              },
            }],
          }, null));
        }
      } else if (type === "response.function_call_arguments.delta") {
        if (typeof obj["delta"] === "string" && obj["delta"] !== "") {
          const oi =
            typeof obj["output_index"] === "number"
              ? obj["output_index"]
              : callIds.length - 1;
          const idx =
            oi >= 0 && oi < callIds.length
              ? oi
              : Math.max(callIds.length - 1, 0);
          ensureRole(controller);
          emit(controller, chunk({
            tool_calls: [{ index: idx, function: { arguments: obj["delta"] } }],
          }, null));
        }
      } else if (
        type === "response.completed" ||
        type === "response.incomplete" ||
        type === "response.failed"
      ) {
        sendDone(controller);
      }
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller): void {
      buf += decoder.decode(bytes, { stream: true });
      const frames = buf.split(/\r?\n\r?\n/);
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        if (frame.trim() !== "") handleFrame(frame, controller);
      }
    },
    flush(controller): void {
      buf += decoder.decode();
      if (buf.trim() !== "") handleFrame(buf, controller);
      sendDone(controller);
    },
  });
}

/**
 * Verbatim SSE passthrough for Responses-native clients: ok upstream
 * streams pipe untouched with SSE framing headers (`x-request-id`
 * preserved when present). Errors go 1:1.
 */
export async function passthroughSseResponse(
  upstream: Response,
): Promise<Response> {
  if (!upstream.ok) return bufferedPassthrough(upstream);
  const headers = new Headers(SSE_RESPONSE_HEADERS);
  const requestId: string | null = upstream.headers.get("x-request-id");
  if (requestId !== null) headers.set("x-request-id", requestId);
  return new Response(bridgeToNativeBody(upstream.body), {
    status: 200,
    headers,
  });
}

/**
 * Map an upstream streaming response to the client response:
 * errors go 1:1, ok Responses-API streams translate to chat chunks
 * (`x-request-id` preserved when present).
 */
export async function toClientSseResponse(
  upstream: Response,
): Promise<Response> {
  if (!upstream.ok) return bufferedPassthrough(upstream);
  const headers = new Headers(SSE_RESPONSE_HEADERS);
  const requestId: string | null = upstream.headers.get("x-request-id");
  if (requestId !== null) headers.set("x-request-id", requestId);
  const bridged = bridgeToNativeBody(upstream.body);
  if (bridged === null) {
    return new Response("data: [DONE]\n\n", { status: 200, headers });
  }
  return new Response(bridged.pipeThrough(responsesToChatTransform()), {
    status: 200,
    headers,
  });
}

interface ResponsesOutputText {
  readonly type: string;
  readonly text?: unknown;
}

interface ResponsesOutputItem {
  readonly type?: unknown;
  readonly call_id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly content?: unknown;
}

/**
 * Map a buffered (non-streaming) Responses object to a Chat Completion.
 * Errors go 1:1; unparseable 200 bodies pass through untouched.
 */
export async function toClientChatCompletion(
  upstream: Response,
): Promise<Response> {
  if (!upstream.ok) return bufferedPassthrough(upstream);
  const text: string = await upstream.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const items: ResponsesOutputItem[] = Array.isArray(payload["output"])
    ? (payload["output"] as ResponsesOutputItem[])
    : [];
  const texts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const item of items) {
    if (item.type === "function_call") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : "",
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "",
          arguments:
            typeof item.arguments === "string" ? item.arguments : "{}",
        },
      });
    } else if (
      (item.type === "message" || item.type === undefined) &&
      Array.isArray(item.content)
    ) {
      for (const part of item.content as ResponsesOutputText[]) {
        if (part.type === "output_text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    }
  }
  const usage =
    typeof payload["usage"] === "object" && payload["usage"] !== null
      ? (payload["usage"] as Record<string, unknown>)
      : {};
  const status = payload["status"];
  const chat = {
    id: `chatcmpl-${String(payload["id"] ?? "zen")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof payload["model"] === "string" ? payload["model"] : "zen",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: texts.join(""),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason:
        toolCalls.length > 0
          ? "tool_calls"
          : status === "incomplete"
            ? "length"
            : "stop",
    }],
    usage: {
      prompt_tokens: typeof usage["input_tokens"] === "number"
        ? usage["input_tokens"]
        : 0,
      completion_tokens: typeof usage["output_tokens"] === "number"
        ? usage["output_tokens"]
        : 0,
      total_tokens: typeof usage["total_tokens"] === "number"
        ? usage["total_tokens"]
        : 0,
    },
  };
  return new Response(JSON.stringify(chat), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
