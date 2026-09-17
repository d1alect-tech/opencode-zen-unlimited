import { expect, test } from "bun:test";
import {
  createCanonicalSessionId,
  createOpenCodeId,
  OPENCODE_ZEN_PUBLIC_TOKEN,
  zenUpstreamHeaders,
} from "@/gateway/zen-identity.ts";

const MSG_RE = /^msg_[0-9A-Za-z]{24}$/;
const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

test("default headers carry the public OpenCode CLI identity", () => {
  const headers = zenUpstreamHeaders();
  expect(headers["Authorization"]).toBe(`Bearer ${OPENCODE_ZEN_PUBLIC_TOKEN}`);
  expect(headers["User-Agent"]?.startsWith("opencode/")).toBe(true);
  expect(headers["Accept"]).toBe("*/*");
  expect(headers["X-Opencode-Client"]).toBe("cli");
  expect(headers["X-Opencode-Project"]).toBe("global");
  expect(MSG_RE.test(headers["X-Opencode-Request"] ?? "")).toBe(true);
  expect(SES_RE.test(headers["X-Opencode-Session"] ?? "")).toBe(true);
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
  expect(MSG_RE.test(createOpenCodeId("msg"))).toBe(true);
});

test("upstream User-Agent passes the 1.17.0 free-tier floor", () => {
  const ua = zenUpstreamHeaders()["User-Agent"] ?? "";
  const m = /^opencode\/(\d+)\.(\d+)\./.exec(ua);
  expect(m).not.toBeNull();
  expect(Number(m?.[1]) * 1000 + Number(m?.[2])).toBeGreaterThanOrEqual(1017);
});

test("createCanonicalSessionId emits the upstream session shape", () => {
  expect(SES_RE.test(createCanonicalSessionId("probe1"))).toBe(true);
});

test("createCanonicalSessionId is deterministic per signal", () => {
  expect(createCanonicalSessionId("probe1")).toBe(
    createCanonicalSessionId("probe1"),
  );
  expect(createCanonicalSessionId("probe1")).not.toBe(
    createCanonicalSessionId("probe2"),
  );
});

test("createCanonicalSessionId passes canonical input through", () => {
  const canonical = createCanonicalSessionId("probe1");
  expect(createCanonicalSessionId(canonical)).toBe(canonical);
});
