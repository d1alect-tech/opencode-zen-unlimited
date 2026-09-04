import { describe, expect, test } from "bun:test";
import { resolveTargetFormat } from "@/registry/types";

describe("resolveTargetFormat", () => {
  test("muse-spark-1.3-contributor-free -> openai-responses", () => {
    expect(resolveTargetFormat("muse-spark-1.3-contributor-free")).toBe("openai-responses");
  });

  test("muse-spark-1.2-contributor-free -> openai-responses", () => {
    expect(resolveTargetFormat("muse-spark-1.2-contributor-free")).toBe("openai-responses");
  });

  test("big-pickle -> openai-chat", () => {
    expect(resolveTargetFormat("big-pickle")).toBe("openai-chat");
  });

  test("deepseek-v4-flash-free -> openai-chat", () => {
    expect(resolveTargetFormat("deepseek-v4-flash-free")).toBe("openai-chat");
  });

  test("override param beats default", () => {
    expect(resolveTargetFormat("big-pickle", "openai-responses")).toBe("openai-responses");
    expect(resolveTargetFormat("muse-spark-1.3-contributor-free", "openai-chat")).toBe(
      "openai-chat",
    );
  });
});
