import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Default pid dir: %LOCALAPPDATA%/zen/pids (Windows) or ./.zen-logs sibling .zen-pids. */
export function resolvePidDir(explicit?: string): string {
  if (explicit) return explicit;
  const local = process.env["LOCALAPPDATA"];
  if (local) return join(local, "zen", "pids");
  return join(process.cwd(), ".zen-pids");
}

export function pidPath(dir: string, name: string): string {
  return join(dir, `${name}.pid`);
}

/** True when a process with this pid exists (signal 0 probe). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePid(dir: string, name: string, pid: number): string {
  mkdirSync(dir, { recursive: true });
  const path = pidPath(dir, name);
  writeFileSync(path, `${pid}\n`, "utf8");
  return path;
}

/**
 * Read a pidfile. Returns null when missing, unparsable, or stale
 * (stale content is removed so the slot is treated as free).
 */
export function readPid(dir: string, name: string): number | null {
  const path = pidPath(dir, name);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort cleanup of stale pidfile
    }
    return null;
  }
  return pid;
}

export function removePid(dir: string, name: string): void {
  try {
    rmSync(pidPath(dir, name), { force: true });
  } catch {
    // missing pidfile is not an error
  }
}
