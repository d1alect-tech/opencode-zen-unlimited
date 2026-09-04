import { execFile } from "node:child_process";

const GRACE_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

/**
 * SIGTERM -> wait 3s -> taskkill /PID /T /F on win32 else SIGKILL.
 * Missing/dead PID resolves without throwing (nodejs#27642 pattern).
 */
export async function killPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    return; // missing PID: no-throw
  }
  if (!alive) return;
  signal(pid, "SIGTERM");
  await sleep(GRACE_MS);
  try {
    process.kill(pid, 0);
  } catch {
    return; // exited during grace
  }
  if (process.platform === "win32") {
    await taskkill(pid);
  } else {
    signal(pid, "SIGKILL");
  }
}
