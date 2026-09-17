import { describe, expect, test } from "bun:test";
import {
  bufferedPassthrough,
  pickForwardHeaders,
  resolveRoute,
  sanitizeResponsesBody,
  stripOcPrefix,
  translateChatToResponses,
  wantsStreaming,
} from "@/gateway/forward";
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

describe("stripOcPrefix", () => {
  test("strips oc/ prefix", () => {
    expect(stripOcPrefix("oc/muse-spark-1.3-contributor-free")).toBe(
      "muse-spark-1.3-contributor-free",
    );
  });

  test("leaves bare ids untouched", () => {
    expect(stripOcPrefix("muse-spark-1.3-contributor-free")).toBe(
      "muse-spark-1.3-contributor-free",
    );
  });

  test("strips only the oc/ prefix, not other scopes", () => {
    expect(stripOcPrefix("other/some-model")).toBe("other/some-model");
  });
});

describe("resolveRoute", () => {
  test("spark model resolves openai-responses route", () => {
    expect(
      resolveRoute("oc/muse-spark-1.3-contributor-free", {
        inboundShape: "chat",
        models: MODELS,
      }),
    ).toBe("/responses");
  });

  test("non-spark model resolves chat route", () => {
    expect(
      resolveRoute("oc/big-pickle", { inboundShape: "chat", models: MODELS }),
    ).toBe("/chat/completions");
  });

  test("registry targetFormat wins over explicit override", () => {
    expect(
      resolveRoute("oc/muse-spark-1.3-contributor-free", {
        inboundShape: "chat",
        models: MODELS,
        override: "openai-chat",
      }),
    ).toBe("/responses");
  });

  test("explicit override beats inbound shape", () => {
    expect(
      resolveRoute("oc/big-pickle", {
        inboundShape: "chat",
        models: MODELS,
        override: "openai-responses",
      }),
    ).toBe("/responses");
  });

  test("inbound responses shape routes unknown models to /responses", () => {
    expect(
      resolveRoute("oc/some-new-model", {
        inboundShape: "responses",
        models: MODELS,
      }),
    ).toBe("/responses");
  });
});

describe("translateChatToResponses", () => {
  test("maps messages to input, strips oc/ prefix, keeps stream + sampling", () => {
    const out = JSON.parse(
      translateChatToResponses(
        JSON.stringify({
          model: "oc/muse-spark-1.3-contributor-free",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          temperature: 0.5,
          top_p: 0.9,
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["model"]).toBe("muse-spark-1.3-contributor-free");
    expect(out["input"]).toEqual([{ role: "user", content: "hi" }]);
    expect(out["stream"]).toBe(true);
    expect(out["temperature"]).toBe(0.5);
    expect(out["top_p"]).toBe(0.9);
    expect("messages" in out).toBe(false);
  });

  test("maps reasoning_effort, max becomes xhigh", () => {
    const out = JSON.parse(
      translateChatToResponses(
        JSON.stringify({
          model: "muse-spark-1.3-contributor-free",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "max",
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["reasoning"]).toEqual({ effort: "xhigh", summary: "auto" });
    expect("reasoning_effort" in out).toBe(false);
  });

  test("maps function tools, tool_choice and max_tokens", () => {
    const out = JSON.parse(
      translateChatToResponses(
        JSON.stringify({
          model: "muse-spark-1.3-contributor-free",
          messages: [{ role: "user", content: "hi" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_time",
                description: "clock",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          tool_choice: "auto",
          max_tokens: 512,
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["tools"]).toEqual([
      {
        type: "function",
        name: "get_time",
        description: "clock",
        parameters: { type: "object", properties: {} },
      },
    ]);
    expect(out["tool_choice"]).toBe("auto");
    expect(out["max_output_tokens"]).toBe(512);
    expect("max_tokens" in out).toBe(false);
  });

  test("maps assistant tool_calls and tool messages", () => {
    const out = JSON.parse(
      translateChatToResponses(
        JSON.stringify({
          model: "muse-spark-1.3-contributor-free",
          messages: [
            { role: "user", content: "time?" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_time", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_1", content: "noon" },
          ],
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["input"]).toEqual([
      { role: "user", content: "time?" },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_time",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_1", output: "noon" },
    ]);
  });

  test("non-JSON passes through untouched", () => {
    expect(translateChatToResponses("not json")).toBe("not json");
  });
});

describe("sanitizeResponsesBody", () => {
  test("drops reasoning items, keeps messages+tool calls, strips oc/", () => {
    const out = JSON.parse(
      sanitizeResponsesBody(
        JSON.stringify({
          model: "oc/muse-spark-1.3-contributor-free",
          previous_response_id: "resp_old",
          input: [
            { role: "user", content: "hi" },
            {
              type: "reasoning",
              id: "rs_old",
              encrypted_content: "SECRET",
              summary: [],
            },
            { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
          ],
        }),
      ),
    ) as Record<string, unknown>;
    expect(out["model"]).toBe("muse-spark-1.3-contributor-free");
    expect(out["input"]).toEqual([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "t", arguments: "{}" },
    ]);
    expect("previous_response_id" in out).toBe(false);
  });

  test("no input array passes through with model stripped", () => {
    const out = JSON.parse(
      sanitizeResponsesBody(JSON.stringify({ model: "oc/x", input: "ping" })),
    ) as Record<string, unknown>;
    expect(out["model"]).toBe("x");
    expect(out["input"]).toBe("ping");
  });

  test("non-JSON passes through untouched", () => {
    expect(sanitizeResponsesBody("not json")).toBe("not json");
  });
});

describe("wantsStreaming", () => {
  test("body stream:true wins over Accept", () => {
    expect(wantsStreaming({ stream: true }, "application/json")).toBe(true);
  });

  test("SSE Accept header opts in when body is silent", () => {
    expect(wantsStreaming({}, "text/event-stream")).toBe(true);
  });

  test("no stream flags means buffered", () => {
    expect(wantsStreaming({}, "application/json")).toBe(false);
    expect(wantsStreaming({}, null)).toBe(false);
  });
});

describe("pickForwardHeaders", () => {
  test("drops content-encoding: decoded bodies must not claim br", () => {
    const upstream = new Headers({
      "Content-Type": "application/json",
      "Content-Encoding": "br",
      "Content-Length": "151",
      "x-request-id": "req-1",
    });
    const out = pickForwardHeaders(upstream);
    expect(out.get("content-encoding")).toBeNull();
    expect(out.get("content-length")).toBeNull();
    expect(out.get("content-type")).toBe("application/json");
    expect(out.get("x-request-id")).toBe("req-1");
  });
});

describe("bufferedPassthrough", () => {
  test("does not forward content-encoding with the decoded body", async () => {
    const upstream = new Response('{"a":1}', {
      status: 403,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "br",
      },
    });
    const res = await bufferedPassthrough(upstream);
    expect(res.status).toBe(403);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe('{"a":1}');
  });
});
