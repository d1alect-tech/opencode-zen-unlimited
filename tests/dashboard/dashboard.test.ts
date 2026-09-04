import { describe, expect, test } from "bun:test";
import { createApp } from "@/gateway/app";
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

function makeApp() {
  return createApp({
    models: MODELS,
    fetchImpl: () => Promise.resolve(new Response("x")),
  });
}

describe("GET /dashboard/providers/opencode", () => {
  test("returns 200 HTML with provider markers and no auth inputs", async () => {
    const app = makeApp();
    const res = await app.request("/dashboard/providers/opencode");
    expect(res.status).toBe(200);
    const ctype: string = res.headers.get("content-type") ?? "";
    expect(ctype).toContain("text/html");
    const html: string = await res.text();
    expect(html).toContain("opencode");
    expect(html).toContain("oc");
    expect(html.toLowerCase()).toContain("no-auth");
    expect(html).not.toContain('type="password"');
    expect(html.toLowerCase()).not.toContain('type="key"');
    expect(html.toLowerCase()).not.toContain("api key");
  });

  test("lists free models from the registry", async () => {
    const app = makeApp();
    const html: string = await (await app.request("/dashboard/providers/opencode")).text();
    expect(html).toContain("muse-spark-1.3-contributor-free");
    expect(html).toContain("big-pickle");
  });
});

describe("GET /api/dashboard/providers/opencode", () => {
  test("returns provider id/alias/models array", async () => {
    const app = makeApp();
    const res = await app.request("/api/dashboard/providers/opencode");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      alias: string;
      name: string;
      baseUrl: string;
      noAuth: boolean;
      models: { id: string }[];
    };
    expect(body.id).toBe("opencode");
    expect(body.alias).toBe("oc");
    expect(body.name).toBe("OpenCode Free");
    expect(body.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(body.noAuth).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);
    const ids: string[] = body.models.map((m) => m.id);
    expect(ids).toContain("muse-spark-1.3-contributor-free");
    expect(ids).toContain("big-pickle");
  });
});
