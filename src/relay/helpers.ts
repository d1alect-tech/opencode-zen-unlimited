// Pure helpers extracted verbatim from src/relay/rr-socks.mjs for testability.
// No logic change: sticky pin, cooldowns, ports 1081-1086, LIMIT_RE intact.
// rr-socks.mjs remains the behavior-identical runtime; this module mirrors its
// pure pieces without side effects (no net/fs/server startup on import).

export interface Upstream {
  host: string;
  port: number;
}

export const PINNED_SUFFIX = "opencode.ai";

export const UPSTREAMS: Upstream[] = [1081, 1082, 1083, 1084, 1085, 1086].map(
  (p) => ({ host: "127.0.0.1", port: p }),
);

export const isPinnedHost = (host: string): boolean =>
  host === PINNED_SUFFIX || String(host).endsWith("." + PINNED_SUFFIX);

export const LIMIT_RE =
  /429|rate.?limited|rate.?limit|quota|freeusagelimit|usage.?limit/i;

export interface PinnedPicker {
  pick: () => Upstream;
  cool: (port: number, ms: number) => void;
}

/** Sticky-pin picker mirroring pickPinned(): starts at UPSTREAMS[1] (1082 DE). */
export function createPinnedPicker(
  upstreams: Upstream[] = UPSTREAMS,
  now: () => number = Date.now,
): PinnedPicker {
  let pinnedIdx = 1;
  const cooldownUntil = new Map<number, number>();
  const isCooled = (port: number): boolean =>
    (cooldownUntil.get(port) ?? 0) > now();
  const at = (idx: number): Upstream => {
    const up = upstreams[idx];
    if (up === undefined) throw new Error(`upstream index ${idx} out of range`);
    return up;
  };
  return {
    pick(): Upstream {
      if (!isCooled(at(pinnedIdx).port)) return at(pinnedIdx);
      for (let k = 1; k <= upstreams.length; k++) {
        const idx = (pinnedIdx + k) % upstreams.length;
        if (!isCooled(at(idx).port)) {
          pinnedIdx = idx;
          return at(idx);
        }
      }
      return at(pinnedIdx);
    },
    cool(port: number, ms: number): void {
      cooldownUntil.set(port, now() + ms);
    },
  };
}

/** Same shape as the ROTATE attr line in pollLimitsOnce(). */
export function formatRotateLine(
  from: number,
  to: number,
  reason: string,
  iso: string = new Date().toISOString(),
): string {
  return `${iso} ROTATE from=${from} to=${to} reason=${String(reason).slice(0, 80)}`;
}

/** Same shape as the per-connection attr line in the relay server. */
export function formatAttrLine(
  up: number,
  host: string,
  port: number,
  pinned: boolean,
  iso: string = new Date().toISOString(),
): string {
  return `${iso} up=${up} target=${host}:${port}${pinned ? " pinned=1" : ""}`;
}
