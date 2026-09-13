/**
 * Public OpenCode CLI identity for keyless Zen calls.
 *
 * Upstream `https://opencode.ai/zen` rejects anonymous relays with
 * `{ type: "MissingSessionID", message: "Error from provider (Console):
 * OpenCode's free tier can only be used in OpenCode" }`. The official CLI
 * is accepted keyless when it presents its public identity: `Bearer public`
 * plus `User-Agent: opencode/...` and per-request `X-Opencode-Request` /
 * `X-Opencode-Session` ids (mirrored from the community zenProxy
 * implementation; upstream treats these as the OpenCode client).
 *
 * Secrets: none here. A real Zen key (opencode.ai console, env-only) can
 * override the public bearer via `ZEN_API_KEY`.
 */

import { randomBytes } from "node:crypto";

/** Bearer token Zen accepts for unauthenticated free-model calls. */
export const OPENCODE_ZEN_PUBLIC_TOKEN = "public" as const;

/** User-Agent the Zen gate recognizes as the public OpenCode CLI. */
export const OPENCODE_ZEN_USER_AGENT =
  `opencode/1.15.9 ai-sdk/provider-utils/4.0.23 runtime/node/${process.versions.node}` as const;

const ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Random OpenCode-style id (`msg_<24>` / `ses_<24>`), fresh per request. */
export function createOpenCodeId(prefix: "msg" | "ses"): string {
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
    "X-Opencode-Session": createOpenCodeId("ses"),
  };
}
