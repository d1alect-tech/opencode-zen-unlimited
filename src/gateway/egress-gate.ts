/**
 * No-egress boot gate (T8).
 *
 * Starting with zero egress nodes must be an explicit error, not a silent
 * direct fallback. The gate runs at serve-boot only — never for
 * doctor/status/logs. Pure (no process.exit inside) so tests can assert the
 * decision; the boot entry maps `allowed:false` to stderr + exit 1.
 */

export const NO_EGRESS_DIRECT_FLAG = "--no-egress-direct" as const;

export const NO_EGRESS_MESSAGE: string =
  "No egress nodes configured. Run 'zen setup' or 'zen add-sub <url>'. Override for local dev only: --no-egress-direct";

export const DIRECT_MODE_WARNING: string =
  "WARNING: running with --no-egress-direct — traffic goes direct without egress rotation. Local dev only.";

export interface EgressGateDecision {
  readonly allowed: boolean;
  /** True only when zero upstreams were explicitly overridden for direct. */
  readonly direct: boolean;
}

/** True when the serve argv carries the explicit direct escape hatch. */
export function hasDirectOverride(argv: readonly string[]): boolean {
  return argv.includes(NO_EGRESS_DIRECT_FLAG);
}

/**
 * Pure gate decision.
 * - upstreams non-empty -> allow, never direct.
 * - empty + override flag -> allow direct (caller logs DIRECT_MODE_WARNING).
 * - empty without flag -> refuse (caller prints NO_EGRESS_MESSAGE, exit 1).
 */
export function evaluateEgressGate(
  upstreams: readonly string[],
  argv: readonly string[],
): EgressGateDecision {
  if (upstreams.length > 0) return { allowed: true, direct: false };
  if (hasDirectOverride(argv)) return { allowed: true, direct: true };
  return { allowed: false, direct: false };
}
