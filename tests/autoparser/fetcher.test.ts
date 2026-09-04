import { describe, expect, test } from "bun:test";
import {
  MODELS_URL,
  fetchModels,
  normalizeModel,
  normalizePayload,
} from "@/autoparser/fetcher";

describe("normalizeModel", () => {
  test("reads id + name", () => {
    expect(normalizeModel({ id: "a-free", name: "A" })).toEqual({ id: "a-free", name: "A" });
  });

  test("normalizes modelId / model_id aliases", () => {
    expect(normalizeModel({ modelId: "b-free", name: "B" })).toEqual({ id: "b-free", name: "B" });
    expect(normalizeModel({ model_id: "c-free", name: "C" })).toEqual({
      id: "c-free",
      name: "C",
    });
  });

  test("normalizes displayName / display_name aliases", () => {
    expect(normalizeModel({ id: "d-free", displayName: "D" })).toEqual({
      id: "d-free",
      name: "D",
    });
    expect(normalizeModel({ id: "e-free", display_name: "E" })).toEqual({
      id: "e-free",
      name: "E",
    });
  });

  test("falls back to id for missing name", () => {
    expect(normalizeModel({ id: "f-free" })).toEqual({ id: "f-free", name: "f-free" });
  });

  test("rejects entries without an id", () => {
    expect(normalizeModel({ name: "No Id" })).toBeUndefined();
    expect(normalizeModel({})).toBeUndefined();
    expect(normalizeModel(null)).toBeUndefined();
  });
});

describe("normalizePayload", () => {
  test("handles { data: [] } envelope", () => {
    const out = normalizePayload({ data: [{ id: "a-free", name: "A" }] });
    expect(out).toEqual([{ id: "a-free", name: "A" }]);
  });

  test("handles bare array", () => {
    const out = normalizePayload([{ id: "b-free" }]);
    expect(out).toEqual([{ id: "b-free", name: "b-free" }]);
  });

  test("drops invalid entries", () => {
    expect(normalizePayload({ data: [{ name: "x" }] })).toEqual([]);
    expect(normalizePayload([])).toEqual([]);
  });
});

describe("fetchModels", () => {
  test("polls keyless GET upstream with no auth headers", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const calls: unknown[] = [];
    const stubFetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seenUrl = String(url);
      seenInit = init;
      calls.push([url, init]);
      return new Response(JSON.stringify({ data: [{ id: "a-free", name: "A" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const out = await fetchModels({ fetchFn: stubFetch });
    expect(out).toEqual([{ id: "a-free", name: "A" }]);
    expect(seenUrl).toBe(MODELS_URL);
    expect(MODELS_URL).toBe("https://opencode.ai/zen/v1/models");
    const headers: Record<string, string> = { ...((seenInit?.headers ?? {}) as Record<string, string>) };
    const keys: string[] = Object.keys(headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain("authorization");
    expect(keys).not.toContain("x-api-key");
    expect(calls.length).toBe(1);
  });

  test("throws on non-ok status", async () => {
    const failing = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      void _url;
      void _init;
      return new Response("oops", { status: 500 });
    }) as typeof fetch;
    let threw = false;
    try {
      await fetchModels({ fetchFn: failing });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
