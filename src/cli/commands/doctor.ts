import {
  collectResults,
  computeExitCode,
  formatHuman,
  formatJson,
  useColor,
  type Check,
} from "../doctor-framework.ts";

export const DOCTOR_HELP: string = [
  "Usage: zen doctor [--json] [--verbose]",
  "",
  "Check gateway, relay and egress health.",
  "",
  "Options:",
  "  --json     Machine-readable report {ok,version,platform,checks[]}",
  "  --verbose  Include per-check timings",
  "  -h, --help  Show this help.",
].join("\n");

/** Injected check list. Empty for now — real checks land in T5/T6. */
export const DOCTOR_CHECKS: readonly Check[] = [];

export interface DoctorOptions {
  readonly json: boolean;
  readonly verbose: boolean;
}

export function parseDoctorArgs(rest: readonly string[]): { ok: true; options: DoctorOptions } | { ok: false; message: string } {
  let json = false;
  let verbose = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else {
      return { ok: false, message: `error: unknown option '${arg}'\n${DOCTOR_HELP}` };
    }
  }
  return { ok: true, options: { json, verbose } };
}

/**
 * Run the doctor command. Returns process exit code:
 * 0 all-pass-or-warn, 1 any-fail, 2 usage error. Never throws.
 */
export async function runDoctor(
  rest: readonly string[],
  deps?: {
    readonly checks?: readonly Check[];
    readonly version?: string;
    readonly platform?: string;
    readonly env?: Record<string, string | undefined>;
  },
): Promise<number> {
  const parsed = parseDoctorArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const checks = deps?.checks ?? DOCTOR_CHECKS;
  const results = await collectResults(checks);
  if (parsed.options.json) {
    console.log(formatJson(results, deps?.version ?? "0.1.0", deps?.platform ?? process.platform));
  } else {
    console.log(
      formatHuman(results, {
        color: useColor(deps?.env ?? process.env),
        verbose: parsed.options.verbose,
      }),
    );
  }
  return computeExitCode(results);
}
