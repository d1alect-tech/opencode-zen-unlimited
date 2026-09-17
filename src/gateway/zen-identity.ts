/**
 * Public OpenCode CLI identity for keyless Zen calls.
 *
 * Upstream `https://opencode.ai/zen` gates the anonymous free tier twice
 * (both verified live 2026-09-17, previously 403 FreeTierError):
 * 1. `X-Opencode-Session` must carry the canonical session shape
 *    `ses_` + 12 lowercase hex + 14 Base62 — random ids are rejected.
 * 2. `User-Agent` must report OpenCode >= 1.17.0 (426 otherwise).
 * Shape mirrors the community zenProxy fixes (opencode2api#28, 9router#4105).
 *
 * Secrets: none here. A real Zen key (opencode.ai console, env-only) can
 * override the public bearer via `ZEN_API_KEY`.
 */

import { createHash, randomBytes } from "node:crypto";

/** Bearer token Zen accepts for unauthenticated free-model calls. */
export const OPENCODE_ZEN_PUBLIC_TOKEN = "public" as const;

/** User-Agent the Zen gate recognizes as the public OpenCode CLI.
 * Pinned above the 1.17.0 free-tier floor (see module docs). */
export const OPENCODE_ZEN_USER_AGENT =
  `opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/node/${process.versions.node}` as const;

const ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Canonical session shape enforced upstream since 2026-09-16. */
const CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Fixed-width Base62 encoding of a big-endian byte string. */
function base62Fixed(bytes: Uint8Array, width: number): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let out = "";
  for (let i = 0; i < width; i += 1) {
    out = BASE62_ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/**
 * Canonical upstream session id: `ses_` + 12 lowercase hex + 14 Base62.
 * Canonical input passes through (upstream prompt-cache affinity);
 * anything else hashes deterministically into the shape so the same
 * signal keeps a stable session. Default signal is random per call.
 */
export function createCanonicalSessionId(signal?: string): string {
  if (signal !== undefined && CANONICAL_SESSION_RE.test(signal)) return signal;
  const seed: string = signal ?? randomBytes(16).toString("hex");
  const sum: Buffer = createHash("sha256").update(`ses\0${seed}`).digest();
  return `ses_${sum.subarray(0, 6).toString("hex")}${base62Fixed(sum.subarray(6, 16), 14)}`;
}

/** Random OpenCode-style request id (`msg_<24>`), fresh per request. */
export function createOpenCodeId(prefix: "msg"): string {
  const bytes: Buffer = randomBytes(24);
  let suffix = "";
  for (const byte of bytes) {
    suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  }
  return `${prefix}_${suffix}`;
}

/** Env-only override: a personal Zen key beats the public bearer. */
export function resolveZenApiKey(
  env: Record<string, string | undefined> = process.env,
): string {
  return env["ZEN_API_KEY"]?.trim() || OPENCODE_ZEN_PUBLIC_TOKEN;
}

export interface ZenIdentityOptions {
  readonly apiKey?: string;
}

/** Upstream headers that pass the Zen OpenCode-client gate. */
export function zenUpstreamHeaders(
  options: ZenIdentityOptions = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${options.apiKey || OPENCODE_ZEN_PUBLIC_TOKEN}`,
    "User-Agent": OPENCODE_ZEN_USER_AGENT,
    Accept: "*/*",
    "X-Opencode-Client": "cli",
    "X-Opencode-Project": "global",
    "X-Opencode-Request": createOpenCodeId("msg"),
    "X-Opencode-Session": createCanonicalSessionId(),
  };
}
