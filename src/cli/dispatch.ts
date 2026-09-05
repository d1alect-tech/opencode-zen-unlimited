import { join } from "node:path";
import { runAddSub } from "./commands/add-sub.ts";
import { runAddProxy } from "./commands/add-proxy.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runSetup } from "./commands/setup.ts";
import { runLogs } from "./commands/logs.ts";
import { runStatus } from "./commands/status.ts";
import { formatHelp } from "./help.ts";
import { parseCliArgs, type Subcommand } from "./parser.ts";
import { startServe } from "../gateway/serve-boot.ts";

export type CliHandler = (rest: readonly string[]) => number | Promise<number>;

function stub(name: Subcommand): CliHandler {
  return (_rest) => {
    console.error(`${name}: not implemented`);
    return 2;
  };
}

/** Dispatch table. Real command logic lands in later tasks; stubs exit 2. */
export const DISPATCH: Record<Subcommand, CliHandler> = {
  doctor: (rest) => runDoctor(rest),
  status: (rest) => runStatus(rest),
  setup: (rest) => runSetup(rest),
  "add-sub": (rest) =>
    runAddSub(rest, {
      configPath: join(process.cwd(), "sing-box", "config.json"),
      envPath: join(process.cwd(), ".env"),
    }),
  "add-proxy": (rest) =>
    runAddProxy(rest, {
      envPath: join(process.cwd(), ".env"),
    }),
  logs: (rest) => runLogs(rest),
  serve: (rest) => startServe(rest),
};

/**
 * Run the CLI over argv (already sliced: process.argv.slice(2)).
 * Returns the process exit code; never throws for usage errors.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.message);
    return parsed.exitCode;
  }
  if (parsed.help || parsed.subcommand === undefined) {
    console.log(formatHelp(parsed.subcommand));
    return 0;
  }
  return await DISPATCH[parsed.subcommand](parsed.rest);
}
