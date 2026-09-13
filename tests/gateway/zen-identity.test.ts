import { expect, test } from "bun:test";
import {
  createOpenCodeId,
  OPENCODE_ZEN_PUBLIC_TOKEN,
  zenUpstreamHeaders,
} from "@/gateway/zen-identity.ts";

const ID_RE = /^(msg|ses)_[0-9A-Za-z]{24}$/;

test("default headers carry the public OpenCode CLI identity", () => {
  const headers = zenUpstreamHeaders();
  expect(headers["Authorization"]).toBe(`Bearer ${OPENCODE_ZEN_PUBLIC_TOKEN}`);
  expect(headers["User-Agent"]?.startsWith("opencode/")).toBe(true);
  expect(headers["Accept"]).toBe("*/*");
  expect(headers["X-Opencode-Client"]).toBe("cli");
  expect(headers["X-Opencode-Project"]).toBe("global");
  expect(ID_RE.test(headers["X-Opencode-Request"] ?? "")).toBe(true);
  expect(ID_RE.test(headers["X-Opencode-Session"] ?? "")).toBe(true);
});

test("explicit apiKey overrides the public bearer token", () => {
  const headers = zenUpstreamHeaders({ apiKey: "sk-test-123" });
  expect(headers["Authorization"]).toBe("Bearer sk-test-123");
});

test("request and session ids are unique per call", () => {
  const a = zenUpstreamHeaders();
  const b = zenUpstreamHeaders();
  expect(a["X-Opencode-Request"]).not.toBe(b["X-Opencode-Request"]);
  expect(a["X-Opencode-Session"]).not.toBe(b["X-Opencode-Session"]);
});

test("createOpenCodeId honors prefix and alphabet", () => {
  expect(ID_RE.test(createOpenCodeId("msg"))).toBe(true);
  expect(ID_RE.test(createOpenCodeId("ses"))).toBe(true);
});
