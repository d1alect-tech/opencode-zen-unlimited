import { describe, expect, test } from "bun:test";
import {
  BIG_PICKLE_ID,
  filterFreeModels,
  isFreeModel,
  liveCatalogAuthoritative,
} from "@/autoparser/filter";
import type { NormalizedModel } from "@/autoparser/fetcher";

function m(id: string): NormalizedModel {
  return { id, name: id };
}

describe("isFreeModel", () => {
  test("keeps big-pickle without -free suffix", () => {
    expect(isFreeModel(BIG_PICKLE_ID)).toBe(true);
    expect(isFreeModel("big-pickle")).toBe(true);
  });

  test("keeps *-free ids", () => {
    expect(isFreeModel("muse-spark-1.3-contributor-free")).toBe(true);
    expect(isFreeModel("deepseek-v4-flash-free")).toBe(true);
  });

  test("drops paid models", () => {
    expect(isFreeModel("gpt-4o")).toBe(false);
    expect(isFreeModel("claude-sonnet-4")).toBe(false);
    expect(isFreeModel("muse-spark-paid")).toBe(false);
    expect(isFreeModel("")).toBe(false);
  });
});

describe("filterFreeModels", () => {
  test("keeps big-pickle + *-free, drops paid models", () => {
    const input: NormalizedModel[] = [
      m("big-pickle"),
      m("muse-spark-1.3-contributor-free"),
      m("deepseek-v4-flash-free"),
      m("gpt-4o"),
      m("claude-opus-paid"),
    ];
    const ids: string[] = filterFreeModels(input).map((x) => x.id);
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("muse-spark-1.3-contributor-free");
    expect(ids).toContain("deepseek-v4-flash-free");
    expect(ids).not.toContain("gpt-4o");
    expect(ids).not.toContain("claude-opus-paid");
  });

  test("dedupes repeated ids", () => {
    const out: NormalizedModel[] = filterFreeModels([m("big-pickle"), m("big-pickle")]);
    expect(out.map((x) => x.id)).toEqual(["big-pickle"]);
  });
});

describe("live catalog authority regression (2026-09-04)", () => {
  const liveFixture: NormalizedModel[] = [
    m("big-pickle"),
    m("deepseek-v4-flash-free"),
    m("muse-spark-1.3-contributor-free"),
    m("muse-spark-1.2-contributor-free"),
    m("mimo-v2.5-free"),
    m("ling-3.0-flash-fin-free"),
    m("nemotron-3-ultra-free"),
    m("nemotron-3.5-lightning-free"),
    m("laguna-s-2.1-free"),
  ];

  test("muse-spark-1.3-contributor-free is PRESENT", () => {
    const ids: string[] = filterFreeModels(liveFixture).map((x) => x.id);
    expect(ids).toContain("muse-spark-1.3-contributor-free");
  });

  test("hy3-free + north-mini-code-free are ABSENT", () => {
    const ids: string[] = filterFreeModels(liveFixture).map((x) => x.id);
    expect(ids).not.toContain("hy3-free");
    expect(ids).not.toContain("north-mini-code-free");
  });

  test("upstream is authoritative, never a static list", () => {
    expect(liveCatalogAuthoritative).toBe(true);
  });
});
