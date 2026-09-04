import { parseArgs } from "node:util";
import { followLog, resolveLogDir, tailLog } from "../../process/logs.ts";
import { COMMAND_HELP } from "../parser.ts";

export const LOG_PROCS = ["singbox", "relay", "gateway"] as const;
export type LogProc = (typeof LOG_PROCS)[number];
export const DEFAULT_TAIL = 50;

export function isLogProc(value: string): value is LogProc {
  return (LOG_PROCS as readonly string[]).includes(value);
}

type FollowOpts = { signal?: AbortSignal; pollMs?: number };
export type FollowImpl = (dir: string, name: string, opts?: FollowOpts) => AsyncGenerator<string, void, void>;

export interface LogsDeps {
  readonly logDir?: string;
  readonly followImpl?: FollowImpl;
}

/**
 * `zen logs <proc> [--tail N] [--follow]`.
 * Prints the last N lines (default 50); with --follow, prints the tail
 * first then streams new lines until Ctrl-C (SIGINT) or the stream ends.
 * Unknown proc (or missing/invalid args) -> usage on stderr, exit 2.
 */
export async function runLogs(rest: readonly string[], deps?: LogsDeps): Promise<number> {
  let proc = "";
  let tailRaw: string | undefined;
  let follow = false;
  try {
    const parsed = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        tail: { type: "string", default: undefined },
        follow: { type: "boolean", default: false },
      },
    });
    if (parsed.values["help"] === true) {
      console.log(COMMAND_HELP["logs"]);
      return 0;
    }
    proc = parsed.positionals[0] ?? "";
    tailRaw = parsed.values["tail"];
    follow = parsed.values["follow"] === true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`error: ${detail}\n${COMMAND_HELP["logs"]}`);
    return 2;
  }

  if (!isLogProc(proc)) {
    console.error(`error: unknown proc '${proc}'\n${COMMAND_HELP["logs"]}`);
    return 2;
  }

  let tail = DEFAULT_TAIL;
  if (tailRaw !== undefined) {
    tail = Number.parseInt(tailRaw, 10);
    if (!Number.isInteger(tail) || tail < 1) {
      console.error(`error: --tail must be a positive integer (got '${tailRaw}')\n${COMMAND_HELP["logs"]}`);
      return 2;
    }
  }

  const dir = deps?.logDir ?? resolveLogDir();
  for (const line of tailLog(dir, proc, tail)) console.log(line);

  if (!follow) return 0;

  const followImpl: FollowImpl = deps?.followImpl ?? followLog;
  const controller = new AbortController();
  const onSigint = (): void => {
    console.log("");
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  try {
    for await (const line of followImpl(dir, proc, { signal: controller.signal })) {
      console.log(line);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return 0;
}
