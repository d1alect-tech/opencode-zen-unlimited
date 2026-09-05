import { describe, expect, test } from "bun:test";
import { createApp } from "@/gateway/app";
import type { UpstreamRequestInit } from "@/gateway/forward";
import type { RegistryModel } from "@/registry/types";

const MODELS: readonly RegistryModel[] = [
  {
    id: "muse-spark-1.3-contributor-free",
    name: "Muse Spark 1.3 Contributor Free",
    targetFormat: "openai-responses",
    contextLength: 1048576,
  },
];

const EGRESSES = ["socks5h://127.0.0.1:18081", "socks5h://127.0.0.1:18082"];

function postResponses(
  app: ReturnType<typeof createApp>,
  model = "oc/muse-spark-1.3-contributor-free",
): Promise<Response> {
  return Promise.resolve(app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "ping" }),
  }));
}

describe("rotation wired into the forward path", () => {
  test("429 on the pinned egress retries the next one", async () => {
    let calls = 0;
    const app = createApp({
      models: MODELS,
      egresses: EGRESSES,
      fetchImpl: (
        _url: string,
        _init: UpstreamRequestInit,
      ): Promise<Response> => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: "quota" }), {
              status: 429,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ output: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      },
    });
    const res = await postResponses(app);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("persistent 429s surface 429 with a gateway retry-after", async () => {
    const app = createApp({
      models: MODELS,
      egresses: EGRESSES,
      fetchImpl: (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "quota" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    });
    const res = await postResponses(app);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).not.toBeNull();
  });
});
