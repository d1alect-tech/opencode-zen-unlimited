/**
 * Serve entry: gateway on loopback-only 127.0.0.1:PORT (default 20128).
 *
 * - Zero args -> legacy serve default through the single choke point
 *   `startServe()` (same gate as `zen serve`).
 * - Bare `--no-egress-direct` (no subcommand) -> serve direct, same choke
 *   point. Any other argv -> CLI dispatch (`serve` subcommand included).
 * - Non-serve commands (doctor/status/logs/...) never touch the egress
 *   gate; it lives inside `startServe()` only.
 */

import { runCli } from "./cli/dispatch.ts";
import { startServe } from "./gateway/serve-boot.ts";
import { NO_EGRESS_DIRECT_FLAG } from "./gateway/egress-gate.ts";

// CLI entry: argv[0] is bun/node in compiled output, so route on slice(2).
// No subcommand -> legacy serve default (`bun run src/index.ts` still serves).
const cliArgs: string[] = process.argv.slice(2);
if (
  cliArgs.length === 0 ||
  (cliArgs.length === 1 && cliArgs[0] === NO_EGRESS_DIRECT_FLAG)
) {
  process.exit(await startServe(cliArgs));
}

process.exit(await runCli(cliArgs));
