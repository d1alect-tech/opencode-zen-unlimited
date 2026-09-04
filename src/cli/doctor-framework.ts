export type CheckResult = "pass" | "fail" | "warn";

export type CheckGroup = "Runtime" | "Binaries" | "Config" | "Ports" | "Services";

export const CHECK_GROUPS: readonly CheckGroup[] = ["Runtime", "Binaries", "Config", "Ports", "Services"];

export interface CheckOutcome {
  readonly result: CheckResult;
  readonly detail?: string;
  readonly fixHint?: string;
}

export interface Check {
  readonly id: string;
  readonly group: CheckGroup;
  readonly run: () => CheckOutcome | Promise<CheckOutcome>;
}

export interface CheckResultRecord {
  readonly id: string;
  readonly group: CheckGroup;
  readonly result: CheckResult;
  readonly detail?: string;
  readonly fixHint?: string;
  readonly durationMs: number;
}

export interface DoctorJson {
  readonly ok: boolean;
  readonly version: string;
  readonly platform: string;
  readonly checks: readonly CheckResultRecord[];
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9_]*_KEY\s*=\s*[^\s]+/g,
  /[A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*[^\s]+/g,
  /TOKEN\s*=\s*[^\s]+/g,
  /SUB_URL\s*=\s*[^\s]+/g,
];

/** Redact secret values: *_KEY=..., *TOKEN*=..., SUB_URL=... -> key=[redacted]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const eq = match.indexOf("=");
      if (eq < 0) return "[redacted]";
      return `${match.slice(0, eq)}=[redacted]`;
    });
  }
  return out;
}

/**
 * Run checks sequentially (cheap -> slow ordering is the caller's
 * responsibility via list order). Each check is isolated: a throw
 * becomes a fail record, never an exception out of this function.
 */
export async function collectResults(checks: readonly Check[]): Promise<CheckResultRecord[]> {
  const records: CheckResultRecord[] = [];
  for (const check of checks) {
    const started = Date.now();
    try {
      const outcome = await check.run();
      records.push({
        id: check.id,
        group: check.group,
        result: outcome.result,
        detail: outcome.detail,
        fixHint: outcome.fixHint,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      records.push({
        id: check.id,
        group: check.group,
        result: "fail",
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        durationMs: Date.now() - started,
      });
    }
  }
  return records;
}

/**
 * Exit matrix: 0 all-pass-or-warn, 1 any-fail.
 * Usage errors (exit 2) are handled by the command layer, not here.
 */
export function computeExitCode(results: readonly CheckResultRecord[]): 0 | 1 {
  return results.some((r) => r.result === "fail") ? 1 : 0;
}

export interface FormatOptions {
  readonly color: boolean;
  readonly verbose: boolean;
}

function symbolFor(result: CheckResult, color: boolean): string {
  if (!color) {
    return `[${result}]`;
  }
  switch (result) {
    case "pass":
      return "[✓]";
    case "fail":
      return "[✗]";
    case "warn":
      return "[!]";
  }
}

/** Human report grouped in CHECK_GROUPS order. Details redacted. */
export function formatHuman(results: readonly CheckResultRecord[], options: FormatOptions): string {
  const lines: string[] = [];
  const grouped = new Map<CheckGroup, CheckResultRecord[]>();
  for (const group of CHECK_GROUPS) {
    grouped.set(group, []);
  }
  for (const record of results) {
    grouped.get(record.group)?.push(record);
  }
  for (const group of CHECK_GROUPS) {
    const items = grouped.get(group) ?? [];
    if (items.length === 0) continue;
    lines.push(`${group}:`);
    for (const item of items) {
      const symbol = symbolFor(item.result, options.color);
      lines.push(`  ${symbol} ${item.id}${item.detail !== undefined ? ` — ${redactSecrets(item.detail)}` : ""}`);
      if (item.fixHint !== undefined && item.fixHint.length > 0) {
        lines.push(`    hint: ${redactSecrets(item.fixHint)}`);
      }
      if (options.verbose) {
        lines.push(`    (${item.durationMs}ms)`);
      }
    }
  }
  const failures = results.filter((r) => r.result === "fail").length;
  const warns = results.filter((r) => r.result === "warn").length;
  lines.push(failures === 0 ? `All checks passed${warns > 0 ? ` (${warns} warning${warns === 1 ? "" : "s"})` : ""}.` : `${failures} check${failures === 1 ? "" : "s"} failed.`);
  return lines.join("\n");
}

/** Machine report. ok mirrors computeExitCode. Secrets redacted. */
export function formatJson(results: readonly CheckResultRecord[], version: string, platform: string): string {
  const payload: DoctorJson = {
    ok: computeExitCode(results) === 0,
    version,
    platform,
    checks: results.map((r) => ({
      id: r.id,
      group: r.group,
      result: r.result,
      ...(r.detail !== undefined ? { detail: redactSecrets(r.detail) } : {}),
      ...(r.fixHint !== undefined ? { fixHint: redactSecrets(r.fixHint) } : {}),
      durationMs: r.durationMs,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/** NO_COLOR=1 (non-empty) disables symbols; empty/unset keeps them. */
export function useColor(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const value = env["NO_COLOR"];
  return value === undefined || value.length === 0 ? true : false;
}
