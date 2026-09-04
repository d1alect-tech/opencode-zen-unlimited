import { parseArgs } from "node:util";

export const SUBCOMMANDS = ["doctor", "status", "setup", "add-sub", "logs", "serve"] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface CliRun {
  readonly ok: true;
  /** Undefined for bare `--help` (global usage). */
  readonly subcommand: Subcommand | undefined;
  readonly help: boolean;
  readonly rest: readonly string[];
}

export interface CliError {
  readonly ok: false;
  readonly exitCode: 2;
  readonly message: string;
}

export type ParsedCli = CliRun | CliError;

export const USAGE: string = [
  "Usage: zen <command> [options]",
  "",
  "Commands:",
  "  doctor    Check gateway, relay and egress health",
  "  status    Show pinned egress and pool status",
  "  setup     Interactive first-run setup",
  "  add-sub   Add a subscription link",
  "  logs      Tail gateway and relay logs",
  "  serve     Start the gateway (refuses with zero egress nodes)",
  "",
  "Options:",
  "  -h, --help  Show help for a command",
  "",
  "Run `zen <command> --help` for command help.",
].join("\n");

export const COMMAND_HELP: Record<Subcommand, string> = {
  doctor: ["Usage: zen doctor [--json] [--verbose]", "", "Check gateway, relay and egress health.", "", "Options:", "  --json     Machine-readable report", "  --verbose  Include per-check timings", "  -h, --help  Show this help."].join(
    "\n",
  ),
  status: ["Usage: zen status [-h]", "", "Show pinned egress and pool status.", "", "Options:", "  -h, --help  Show this help."].join(
    "\n",
  ),
  setup: ["Usage: zen setup [-h]", "", "Interactive first-run setup.", "", "Options:", "  -h, --help  Show this help."].join(
    "\n",
  ),
  "add-sub": ["Usage: zen add-sub [-h]", "", "Add a subscription link.", "", "Options:", "  -h, --help  Show this help."].join(
    "\n",
  ),
  logs: [
    "Usage: zen logs <proc> [--tail N] [--follow] [-h]",
    "",
    "Tail process logs (procs: singbox, relay, gateway).",
    "",
    "Arguments:",
    "  proc  One of: singbox, relay, gateway.",
    "",
    "Options:",
    "  --tail N   Show the last N lines (default 50).",
    "  --follow   Stream new lines until Ctrl-C.",
    "  -h, --help  Show this help.",
  ].join("\n"),
  serve: ["Usage: zen serve [--no-egress-direct] [-h]", "", "Start the gateway. Refuses when EGRESS_UPSTREAMS is empty", "unless --no-egress-direct is passed (local dev only, direct traffic).", "", "Options:", "  --no-egress-direct  Serve direct without egress nodes (local dev only).", "  -h, --help  Show this help."].join(
    "\n",
  ),
};

export function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Two-pass parse over argv (already sliced: process.argv.slice(2),
 * since argv[0] is bun/node in compiled output).
 *
 * Pass 1: tokens:true, strict:false — find the subcommand as the
 * first positional token without choking on per-command flags.
 * Pass 2: strict per-command parse for `--help` only.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCli {
  const args = [...argv];

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    return { ok: true, subcommand: undefined, help: true, rest: [] };
  }

  let firstPositional: string | undefined;
  try {
    const pass1 = parseArgs({ args, tokens: true, strict: false, allowPositionals: true });
    firstPositional = pass1.tokens.find((t) => t.kind === "positional")?.value;
  } catch {
    return { ok: false, exitCode: 2, message: `error: cannot parse arguments\n${USAGE}` };
  }

  if (firstPositional === undefined || !isSubcommand(firstPositional)) {
    const got = firstPositional ?? args[0] ?? "";
    return { ok: false, exitCode: 2, message: `error: unknown command '${got}'\n${USAGE}` };
  }
  const subcommand: Subcommand = firstPositional;

  let help = false;
  let rest: string[] = [];
  try {
    if (subcommand === "logs") {
      // Logs owns --tail/--follow: accept them here, re-encode into rest
      // so the command handler can parse them (pass1-style strict per command).
      const pass2 = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          help: { type: "boolean", short: "h", default: false },
          tail: { type: "string", default: undefined },
          follow: { type: "boolean", default: false },
        },
      });
      help = pass2.values["help"] === true;
      rest = pass2.positionals.slice(1);
      const tail = pass2.values["tail"];
      if (typeof tail === "string") rest.push("--tail", tail);
      if (pass2.values["follow"] === true) rest.push("--follow");
    } else if (subcommand === "doctor") {
      // Doctor owns --json/--verbose: accept them here, re-encode into rest
      // so the command handler can parse them (pass1-style strict per command).
      const pass2 = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          help: { type: "boolean", short: "h", default: false },
          json: { type: "boolean", default: false },
          verbose: { type: "boolean", default: false },
        },
      });
      help = pass2.values["help"] === true;
      rest = pass2.positionals.slice(1);
      if (pass2.values["json"] === true) rest.push("--json");
      if (pass2.values["verbose"] === true) rest.push("--verbose");
    } else if (subcommand === "serve") {
      // Serve owns --no-egress-direct: accept it here, re-encode into rest
      // so the boot choke point sees the explicit direct escape hatch.
      const pass2 = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          help: { type: "boolean", short: "h", default: false },
          "no-egress-direct": { type: "boolean", default: false },
        },
      });
      help = pass2.values["help"] === true;
      rest = pass2.positionals.slice(1);
      if (pass2.values["no-egress-direct"] === true) rest.push("--no-egress-direct");
    } else {
      const pass2 = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: { help: { type: "boolean", short: "h", default: false } },
      });
      help = pass2.values["help"] === true;
      rest = pass2.positionals.slice(1);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, exitCode: 2, message: `error: ${detail}\n${COMMAND_HELP[subcommand]}` };
  }

  return { ok: true, subcommand, help, rest };
}
