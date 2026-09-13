import { describe, expect, test } from "bun:test";
import { bridgeToNativeBody } from "@/gateway/forward";
import { toClientChatCompletion, toClientSseResponse } from "@/gateway/sse";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const total: number = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged);
}

describe("bridgeToNativeBody", () => {
  test("null stays null", () => {
    expect(bridgeToNativeBody(null)).toBeNull();
  });

  test("pumps chunks in order until close", async () => {
    const src = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: a\n\n"));
        controller.enqueue(new TextEncoder().encode("data: b\n\n"));
        controller.close();
      },
    });
    const bridged = bridgeToNativeBody(src);
    expect(bridged).not.toBeNull();
    await expect(readAll(bridged as ReadableStream<Uint8Array>)).resolves.toBe(
      "data: a\n\ndata: b\n\n",
    );
  });

  test("cancel propagates to the upstream reader", async () => {
    let cancelled = false;
    const src = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("data: x\n\n"));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const bridged = bridgeToNativeBody(src) as ReadableStream<Uint8Array>;
    await bridged.cancel("client-gone");
    expect(cancelled).toBe(true);
  });
});

function sseResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function chatFrames(text: string): Record<string, string>[] {
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data:"))
    .map((f) => ({ raw: f, data: f.slice("data:".length).trim() }));
}

describe("toClientSseResponse", () => {
  test("translates responses text deltas to chat content chunks", async () => {
    const upstream = sseResponse(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    );
    const res: Response = await toClientSseResponse(upstream);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await readAll(res.body as ReadableStream<Uint8Array>);
    expect(text).not.toContain("response.output_text.delta");
    const frames = chatFrames(text);
    const bodies = frames
      .filter((f) => f.data !== "[DONE]")
      .map((f) => JSON.parse(f.data ?? "") as Record<string, unknown>);
    expect(frames[frames.length - 1]?.data).toBe("[DONE]");
    const contents = bodies.flatMap((b) => {
      const choices = b["choices"] as { delta?: { content?: string } }[];
      return choices.map((c) => c.delta?.content ?? "");
    });
    expect(contents.join("")).toBe("hello");
    for (const b of bodies) {
      expect(b["object"]).toBe("chat.completion.chunk");
    }
  });

  test("translates function call deltas to chat tool_calls", async () => {
    const upstream = sseResponse(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"get_time","arguments":""}}\n\n' +
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{}","output_index":0}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    );
    const res: Response = await toClientSseResponse(upstream);
    const text = await readAll(res.body as ReadableStream<Uint8Array>);
    expect(text).toContain('"tool_calls"');
    expect(text).toContain("call_1");
    expect(text).toContain("get_time");
    expect(text.trimEnd().endsWith("data: [DONE]"));
  });

  test("drops unknown events but still terminates with DONE", async () => {
    const upstream = sseResponse(
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}\n\n',
    );
    const res: Response = await toClientSseResponse(upstream);
    const text = await readAll(res.body as ReadableStream<Uint8Array>);
    expect(text).not.toContain("thinking");
    expect(text.trimEnd().endsWith("data: [DONE]"));
  });

  test("buffered response object becomes a chat completion", async () => {
    const upstream = new Response(
      JSON.stringify({
        id: "resp_9",
        object: "response",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hi" }],
          },
          {
            type: "function_call",
            call_id: "c1",
            name: "get_time",
            arguments: "{}",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const res: Response = await toClientChatCompletion(upstream);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: {
        message: {
          role: string;
          content: string;
          tool_calls: { id: string; function: { name: string } }[];
        };
        finish_reason: string;
      }[];
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("hi");
    expect(body.choices[0]?.message.tool_calls[0]?.id).toBe("c1");
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
    expect(body.usage.prompt_tokens).toBe(10);
  });

  test("error upstream maps 1:1 without bridging", async () => {
    const upstream = new Response(JSON.stringify({ error: "bad" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    const res: Response = await toClientSseResponse(upstream);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad" });
  });
});
