import { describe, expect, test } from "bun:test";
import { bridgeToNativeBody } from "@/gateway/forward";
import { toClientSseResponse } from "@/gateway/sse";

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

describe("toClientSseResponse", () => {
  test("ok upstream streams bytes through a servable body", async () => {
    const upstream = new Response("data: hello\n\ndata: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const res: Response = await toClientSseResponse(upstream);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();
    await expect(
      readAll(res.body as ReadableStream<Uint8Array>),
    ).resolves.toBe("data: hello\n\ndata: [DONE]\n\n");
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
