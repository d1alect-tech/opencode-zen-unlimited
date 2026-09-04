import { describe, expect, test } from "bun:test";
import { resolveRoute, stripOcPrefix, wantsStreaming } from "@/gateway/forward";
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
