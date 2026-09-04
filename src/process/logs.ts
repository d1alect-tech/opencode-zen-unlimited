import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const MAX_GENERATIONS = 5;

/** Default log dir: %LOCALAPPDATA%/zen/logs (Windows) or ./.zen-logs. */
export function resolveLogDir(explicit?: string): string {
  if (explicit) return explicit;
  const local = process.env["LOCALAPPDATA"];
  if (local) return join(local, "zen", "logs");
  return join(process.cwd(), ".zen-logs");
}

export function logPath(dir: string, name: string): string {
  return join(dir, `${name}.log`);
}

export function appendLog(dir: string, name: string, line: string): void {
  mkdirSync(dir, { recursive: true });
  const path = logPath(dir, name);
  rotateLog(dir, name);
  appendFileSync(path, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

/** pm2-logrotate style: max_size 5MB, retain 5 generations (.1..5). */
export function rotateLog(dir: string, name: string): void {
  const path = logPath(dir, name);
  if (!existsSync(path)) return;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;
  // Shift .4->.5, ..., .1->.2; drop .5+ overflow.
  try {
    rmSync(`${path}.6`, { force: true });
  } catch {
    // ignore
  }
  for (let i = MAX_GENERATIONS - 1; i >= 1; i--) {
    const src = `${path}.${i}`;
    const dst = `${path}.${i + 1}`;
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {
        // best effort
      }
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // best effort
  }
  try {
    writeFileSync(path, "", "utf8");
  } catch {
    // best effort
  }
}

/** Return the last n lines of the log (empty array when missing). */
export function tailLog(dir: string, name: string, n: number): string[] {
  const path = logPath(dir, name);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (n <= 0) return [];
  return lines.slice(Math.max(0, lines.length - n));
}

/** Async generator yielding new lines appended after the call (poll-based). */
export async function* followLog(
  dir: string,
  name: string,
  opts?: { signal?: AbortSignal; pollMs?: number },
): AsyncGenerator<string, void, void> {
  const path = logPath(dir, name);
  let offset = 0;
  try {
    if (existsSync(path)) offset = statSync(path).size;
  } catch {
    offset = 0;
  }
  const pollMs = opts?.pollMs ?? 250;
  let carried = "";
  while (opts?.signal ? !opts.signal.aborted : true) {
    if (opts?.signal?.aborted) return;
    let chunk = "";
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (text.length < offset) offset = 0; // rotated/truncated
        if (text.length > offset) {
          chunk = text.slice(offset);
          offset = text.length;
        }
      }
    } catch {
      chunk = "";
    }
    if (chunk) {
      carried += chunk;
      const parts = carried.split("\n");
      carried = parts.pop() ?? "";
      for (const line of parts) yield line;
    }
    await Bun.sleep(pollMs);
  }
  if (carried) yield carried;
}
