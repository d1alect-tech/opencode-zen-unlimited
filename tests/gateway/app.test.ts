import { describe, expect, test } from "bun:test";
import { createApp } from "@/gateway/app";
import type { UpstreamRequestInit } from "@/gateway/forward";
import { fetchUpstream } from "@/gateway/sse";
import type { RegistryModel } from "@/registry/types";

const MODELS: readonly RegistryModel[] = [
  {
    id: "muse-spark-1.3-contributor-free",
    name: "Muse Spark 1.3 Contributor Free",
    targetFormat: "openai-responses",
    contextLength: 1048576,
  },
  { id: "big-pickle", name: "Big Pickle", contextLength: 262144 },
];

interface Captured {
  url: string;
  init: UpstreamRequestInit;
}

function mockFetch(handler: (captured: Captured) => Response) {
  const captured: Captured[] = [];
  const fetchImpl = (
    url: string,
    init: UpstreamRequestInit,
  ): Promise<Response> => {
    const entry: Captured = { url, init };
    captured.push(entry);
    return Promise.resolve(handler(entry));
  };
  return { captured, fetchImpl };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /api/health", () => {
  test("returns 200", async () => {
    const app = createApp({ models: MODELS, fetchImpl: () => Promise.resolve(new Response("x")) });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /v1/models", () => {
  test("returns dual ids oc/<id> + <id>", async () => {
    const app = createApp({ models: MODELS, fetchImpl: () => Promise.resolve(new Response("x")) });
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain("oc/muse-spark-1.3-contributor-free");
    expect(ids).toContain("muse-spark-1.3-contributor-free");
  });
});

describe("POST /v1/chat/completions", () => {
  test("spark model routes to upstream /responses with stripped model", async () => {
    const { captured, fetchImpl } = mockFetch(() =>
      jsonResponse({ output: "ok" }),
    );
    const app = createApp({ models: MODELS, fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "oc/muse-spark-1.3-contributor-free",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://opencode.ai/zen/v1/responses");
    const sent = JSON.parse((captured[0]?.init.body as string) ?? "{}") as {
      model: string;
    };
    expect(sent.model).toBe("muse-spark-1.3-contributor-free");
  });

  test("non-spark model routes to upstream /chat/completions", async () => {
    const { captured, fetchImpl } = mockFetch(() =>
      jsonResponse({ choices: [] }),
    );
    const app = createApp({ models: MODELS, fetchImpl });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "oc/big-pickle", messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(captured[0]?.url).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
  });
});

describe("POST /v1/responses", () => {
  test("forwards verbatim to upstream /responses, strips only oc/ prefix", async () => {
    const { captured, fetchImpl } = mockFetch(() =>
      jsonResponse({ output: "ok" }),
    );
    const app = createApp({ models: MODELS, fetchImpl });
    const inbound = {
      model: "oc/muse-spark-1.3-contributor-free",
      input: "ping",
      temperature: 0.2,
    };
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inbound),
    });
    expect(res.status).toBe(200);
    expect(captured[0]?.url).toBe("https://opencode.ai/zen/v1/responses");
    const sent = JSON.parse((captured[0]?.init.body as string) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({ ...inbound, model: "muse-spark-1.3-contributor-free" });
  });
});

describe("upstream error mapping", () => {
  test("non-ok maps 1:1 (status + body, preserves x-request-id)", async () => {
    const { fetchImpl } = mockFetch(
      () =>
        new Response(JSON.stringify({ error: "quota" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "req-123",
          },
        }),
    );
    const app = createApp({ models: MODELS, fetchImpl });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "oc/muse-spark-1.3-contributor-free",
        input: "ping",
      }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("x-request-id")).toBe("req-123");
    expect(await res.json()).toEqual({ error: "quota" });
  });
});

describe("SSE passthrough", () => {
  test("streaming sets SSE headers and pipes upstream bytes", async () => {
    const sseBody = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const { fetchImpl } = mockFetch(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    const app = createApp({ models: MODELS, fetchImpl });
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        model: "oc/muse-spark-1.3-contributor-free",
        input: "ping",
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(await res.text()).toBe(sseBody);
  });
});

describe("abort propagation", () => {
  test("client abort aborts the upstream request", async () => {
    const clientController = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = (
      _url: string,
      init: UpstreamRequestInit,
    ): Promise<Response> => {
      upstreamSignal = init.signal ?? undefined;
      return Promise.resolve(jsonResponse({ output: "ok" }));
    };
    const call = fetchUpstream("https://opencode.ai/zen/v1/responses", "{}", {
      fetchImpl,
      clientSignal: clientController.signal,
    });
    clientController.abort();
    const { upstreamController } = await call;
    expect(upstreamSignal).toBeDefined();
    expect(upstreamController.signal.aborted).toBe(true);
  });
});

describe("GET /api/usage/proxy-logs", () => {
  test("watcher-compat minimal shape with logged entries", async () => {
    const { fetchImpl } = mockFetch(() => jsonResponse({ output: "ok" }));
    const app = createApp({ models: MODELS, fetchImpl });
    await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "oc/muse-spark-1.3-contributor-free",
        input: "ping",
      }),
    });
    const res = await app.request("/api/usage/proxy-logs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: { status: number }[];
      total: number;
    };
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.logs[0]?.status).toBe(200);
  });
});
