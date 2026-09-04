import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { logPath, resolveLogDir } from "./logs.ts";
import { resolvePidDir, writePid } from "./pidfile.ts";

export interface SpawnOptions {
  name: string;
  logDir?: string;
  pidDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Detached spawn with stdout/stderr redirected to
 * <logDir>/<name>.log and pid recorded in <pidDir>/<name>.pid.
 * Returns the child pid. PM2 out_file/error_file pattern (merged).
 */
export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions): number {
  const logDir = resolveLogDir(opts.logDir);
  const pidDir = resolvePidDir(opts.pidDir);
  mkdirSync(logDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const out = openSync(logPath(logDir, opts.name), "a");
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`spawnDetached: no pid for ${opts.name}`);
  }
  writePid(pidDir, opts.name, pid);
  child.unref();
  return pid;
}
