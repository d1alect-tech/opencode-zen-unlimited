/**
 * Crash toast seam (plan T3).
 *
 * `notifyCrash()` is the single seam the supervisor path (T7) calls when a
 * managed process dies. It is mock-tested: unit tests inject a fake
 * notifier, so no real OS toast ever fires in CI.
 *
 * Backend note: the optional `node-notifier` dependency delivers OS TOASTS
 * only — it is not a tray/systray icon, and this module adds no tray code.
 * `node-notifier` is intentionally NOT in package.json: it is resolved via
 * a lazy optional `require()` attempt at call time and the call degrades
 * to a silent no-op when the module is absent (CI, minimal installs).
 *
 * Quiet rule: `opts.quiet` (wired to `--quiet` by the caller) suppresses
 * the toast entirely — the injected notifier is not even invoked.
 */

import { createRequire } from "node:module";

/** Payload delivered to the notifier. */
export interface CrashPayload {
  proc: string;
  lines: string[];
  title: string;
  message: string;
}

/** Injectable toast sink. Defaults to the lazy node-notifier attempt. */
export type CrashNotifier = (payload: CrashPayload) => void;

export interface NotifyCrashOptions {
  /** Mirrors `--quiet`: suppress the toast, never call the notifier. */
  quiet?: boolean;
  /** Toast title override. Defaults to `zen <proc> crashed`. */
  title?: string;
  /** Test seam: fake sink used by unit tests. */
  notifier?: CrashNotifier;
}

const MAX_MESSAGE_CHARS = 500;

function buildPayload(proc: string, lastLogLines: string[], title?: string): CrashPayload {
  const lines = lastLogLines.slice();
  const lastNonEmpty = [...lines].reverse().find((l) => l.trim() !== "");
  const message = (lastNonEmpty ?? "process crashed").slice(0, MAX_MESSAGE_CHARS);
  return {
    proc,
    lines,
    title: title ?? `zen ${proc} crashed`,
    message,
  };
}

interface NodeNotifierLike {
  notify: (opts: { title: string; message: string }) => void;
}

function loadNodeNotifier(): NodeNotifierLike | undefined {
  try {
    const require = createRequire(import.meta.url);
    const mod: unknown = require("node-notifier");
    if (typeof mod !== "object" || mod === null) return undefined;
    if (!("notify" in mod)) return undefined;
    const candidate: unknown = (mod as { notify: unknown }).notify;
    if (typeof candidate !== "function") return undefined;
    const fn = candidate as (opts: { title: string; message: string }) => void;
    return { notify: fn };
  } catch {
    return undefined;
  }
}

/** Default sink: lazy node-notifier attempt, silent no-op when absent. */
function defaultNotify(payload: CrashPayload): void {
  const nn = loadNodeNotifier();
  if (nn === undefined) return;
  nn.notify({ title: payload.title, message: payload.message });
}

/**
 * Fire a crash toast for `proc` with the trailing log lines as context.
 * Never throws: toast failures are swallowed so the supervisor path stays
 * alive. No-op when `opts.quiet` is set or no backend is available.
 */
export function notifyCrash(proc: string, lastLogLines: string[], opts?: NotifyCrashOptions): void {
  if (opts?.quiet === true) return;
  const notifier: CrashNotifier = opts?.notifier ?? defaultNotify;
  const payload = buildPayload(proc, lastLogLines, opts?.title);
  try {
    notifier(payload);
  } catch {
    // Toast backends must never take down the supervisor. Silent.
  }
}
