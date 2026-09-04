import { describe, expect, test } from "bun:test";
import {
  toGatewayCatalog,
  toGatewayCatalogIds,
  toRegistryEntry,
  toRegistryModels,
} from "@/autoparser/emitter";
import type { NormalizedModel } from "@/autoparser/fetcher";

function m(id: string): NormalizedModel {
  return { id, name: id };
}

describe("toRegistryModels", () => {
  test("emits RegistryEntry model blocks with id + name", () => {
    const out = toRegistryModels([m("big-pickle")]);
    expect(out.length).toBe(1);
    expect(out[0]?.id).toBe("big-pickle");
    expect(out[0]?.name).toBe("big-pickle");
    expect(typeof out[0]?.contextLength).toBe("number");
  });

  test("muse-spark-* entries carry targetFormat openai-responses", () => {
    const out = toRegistryModels([m("muse-spark-1.3-contributor-free"), m("big-pickle")]);
    const spark = out.find((x) => x.id === "muse-spark-1.3-contributor-free");
    expect(spark?.targetFormat).toBe("openai-responses");
  });
});

describe("toRegistryEntry", () => {
  test("builds oc RegistryEntry with modelsUrl", () => {
    const entry = toRegistryEntry([m("big-pickle"), m("muse-spark-1.3-contributor-free")]);
    expect(entry.id).toBe("opencode");
    expect(entry.alias).toBe("oc");
    expect(entry.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(entry.modelsUrl).toBe("https://opencode.ai/zen/v1/models");
    expect(entry.models.length).toBe(2);
  });
});

describe("gateway catalog dual ids", () => {
  test("produces oc/<id> + <id> for every model", () => {
    const ids: string[] = toGatewayCatalogIds([m("big-pickle"), m("a-free")]);
    expect(ids).toContain("oc/big-pickle");
    expect(ids).toContain("big-pickle");
    expect(ids).toContain("oc/a-free");
    expect(ids).toContain("a-free");
    expect(ids.length).toBe(4);
  });

  test("toGatewayCatalog carries both id forms", () => {
    const catalog = toGatewayCatalog([m("big-pickle")]);
    const ids: string[] = catalog.map((c) => c.id);
    expect(ids).toContain("oc/big-pickle");
    expect(ids).toContain("big-pickle");
  });

  test("spark catalog items pin openai-responses", () => {
    const catalog = toGatewayCatalog([m("muse-spark-1.3-contributor-free")]);
    for (const item of catalog) {
      expect(item.targetFormat).toBe("openai-responses");
    }
  });
});
