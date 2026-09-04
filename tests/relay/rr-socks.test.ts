import { describe, expect, test } from "bun:test";
import {
  LIMIT_RE,
  UPSTREAMS,
  createPinnedPicker,
  formatAttrLine,
  formatRotateLine,
  isPinnedHost,
} from "../../src/relay/helpers.ts";

describe("isPinnedHost", () => {
  test("bare opencode.ai is pinned", () => {
    expect(isPinnedHost("opencode.ai")).toBe(true);
  });
  test("subdomain of opencode.ai is pinned", () => {
    expect(isPinnedHost("sub.opencode.ai")).toBe(true);
  });
  test("other hosts are not pinned", () => {
    expect(isPinnedHost("example.com")).toBe(false);
    expect(isPinnedHost("opencode.ai.evil.com")).toBe(false);
    expect(isPinnedHost("notopencode.ai.other")).toBe(false);
  });
});

describe("pickPinned", () => {
  test("starts at 1082 DE (index 1)", () => {
    const picker = createPinnedPicker();
    expect(picker.pick().port).toBe(1082);
    expect(UPSTREAMS[1]?.port).toBe(1082);
  });
  test("cooled port is skipped", () => {
    const picker = createPinnedPicker();
    picker.cool(1082, 60_000);
    expect(picker.pick().port).toBe(1083);
  });
  test("all-cooled stays on current pinned port", () => {
    const picker = createPinnedPicker();
    for (const u of UPSTREAMS) picker.cool(u.port, 60_000);
    expect(picker.pick().port).toBe(1082);
  });
});

describe("LIMIT_RE", () => {
  test.each([
    "429 Too Many Requests",
    "rate limited",
    "rate-limited",
    "quota exceeded",
    "freeusagelimit",
    "usage limit reached",
  ])("matches %p", (msg) => {
    expect(LIMIT_RE.test(msg)).toBe(true);
  });
  test("does not match unrelated errors", () => {
    expect(LIMIT_RE.test("connection refused")).toBe(false);
  });
});

describe("log line formats", () => {
  test("ROTATE line matches /ROTATE from=\\d+ to=\\d+ reason=/", () => {
    const line = formatRotateLine(1082, 1083, "429 quota exceeded");
    expect(line).toMatch(/ROTATE from=\d+ to=\d+ reason=/);
  });
  test("attr line carries pinned=1 for pinned targets", () => {
    const line = formatAttrLine(1082, "sub.opencode.ai", 443, true);
    expect(line).toMatch(/up=\d+ target=.*pinned=1/);
  });
  test("attr line omits pinned=1 for non-pinned targets", () => {
    const line = formatAttrLine(1081, "example.com", 443, false);
    expect(line).toMatch(/up=\d+ target=/);
    expect(line).not.toContain("pinned=1");
  });
});
