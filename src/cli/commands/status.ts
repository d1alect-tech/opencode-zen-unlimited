/**
 * `zen status [--json] [--self-heal] [--verbose]` (plan T7).
 *
 * Prints one row per managed proc (singbox | relay | gateway):
 * liveness comes from the pidfile (`readPid`, stale entries count as
 * dead), plus a per-proc health extra — gateway probes `/api/health`,
 * relay probes TCP :1090, sing-box is process-only. Uptime derives from
 * the pidfile mtime. `--json` emits the machine shape
 * `{ok, services:[{name,alive,pid,uptimeMs,detail}]}`.
 *
 * `--self-heal` restarts dead procs through `spawnDetached` (same entry
 * points the stack boots from: gateway via `src/index.ts serve`, relay
 * via `src/relay/rr-socks.mjs`, sing-box via the `sing-box` binary) and
 * fires `notifyCrash` for every crash found. Self-heal never throws:
 * per-proc try/catch reports `failed <name>: <reason>`.
 *
 * Exit codes: 0 healed-or-healthy, 1 still-down, 2 usage. Never throws
 * for usage errors; probes are timeout-bounded and failure-safe.
 */

import { existsSync, statSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_HELP } from "../parser.ts";
import { tailLog, resolveLogDir } from "../../process/logs.ts";
import { notifyCrash } from "../../process/notify.ts";
import { pidPath, readPid, resolvePidDir } from "../../process/pidfile.ts";
import { spawnDetached } from "../../process/spawn.ts";

export const STATUS_SERVICES = ["singbox", "relay", "gateway"] as const;
export type StatusService = (typeof STATUS_SERVICES)[number];

/** Network probes give up after this long (mirrors doctor-checks-b). */
export const STATUS_PROBE_TIMEOUT_MS = 3000;

const GATEWAY_BASE = "http://127.0.0.1:20128";
const RELAY_PORT = 1090;

/** Legacy pidfile slot written by older tooling (doctor uses `sing-box`). */
const SINGBOX_ALIASES: readonly string[] = ["singbox", "sing-box"];

export interface ServiceSpec {
  readonly cmd: string;
  readonly args: readonly string[];
}

export interface ServiceStatus {
  readonly name: StatusService;
  readonly alive: boolean;
  readonly pid: number | null;
  readonly uptimeMs: number | null;
  readonly detail: string;
}

export interface StatusOptions {
  readonly json: boolean;
  readonly selfHeal: boolean;
  readonly verbose: boolean;
}

type SpawnFn = (cmd: string, args: readonly string[], opts: { name: string; logDir?: string; pidDir?: string }) => number;

export interface StatusDeps {
  readonly pidDir?: string;
  readonly logDir?: string;
  readonly readPidFn?: (dir: string, name: string) => number | null;
  readonly tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  readonly fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  readonly spawnFn?: SpawnFn;
  readonly notifyFn?: (proc: string, lines: string[]) => void;
  readonly tailFn?: (dir: string, name: string, n: number) => string[];
  readonly specs?: Partial<Record<StatusService, ServiceSpec>>;
  readonly gatewayBase?: string;
  readonly now?: () => number;
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

async function fetchWithTimeout(
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>,
  url: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Default spawn specs: the same entry points the stack boots from. */
function defaultSpecs(): Record<StatusService, ServiceSpec> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const entry = join(here, "..", "..", "index.ts");
  const relayEntry = join(here, "..", "..", "relay", "rr-socks.mjs");
  return {
    gateway: { cmd: "bun", args: ["run", entry, "serve"] },
    relay: { cmd: "bun", args: [relayEntry] },
    singbox: {
      cmd: "sing-box",
      args: ["run", "-c", process.env["SINGBOX_CONFIG"] ?? "config.json"],
    },
  };
}

function pidMtimeMs(pidDir: string, slot: string): number | null {
  const path = pidPath(pidDir, slot);
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

interface LiveDeps {
  readonly pidDir: string;
  readonly readPidFn: (dir: string, name: string) => number | null;
  readonly tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  readonly fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  readonly gatewayBase: string;
  readonly now: () => number;
}

/** Resolve the pidfile slot holding a live pid (singbox tries both spellings). */
function resolveSlot(deps: LiveDeps, name: StatusService): { pid: number | null; slot: string } {
  if (name === "singbox") {
    for (const slot of SINGBOX_ALIASES) {
      const pid = deps.readPidFn(deps.pidDir, slot);
      if (pid !== null) return { pid, slot };
    }
    return { pid: null, slot: "singbox" };
  }
  return { pid: deps.readPidFn(deps.pidDir, name), slot: name };
}

async function checkService(deps: LiveDeps, name: StatusService): Promise<ServiceStatus> {
  const { pid, slot } = resolveSlot(deps, name);
  if (pid === null) {
    return { name, alive: false, pid: null, uptimeMs: null, detail: "pidfile missing or stale" };
  }
  const mtime = pidMtimeMs(deps.pidDir, slot);
  const uptimeMs = mtime === null ? null : Math.max(0, Math.round(deps.now() - mtime));
  if (name === "singbox") {
    return { name, alive: true, pid, uptimeMs, detail: `pid ${pid} alive` };
  }
  if (name === "relay") {
    let open = false;
    try {
      open = await deps.tcpProbe("127.0.0.1", RELAY_PORT, STATUS_PROBE_TIMEOUT_MS);
    } catch {
      open = false;
    }
    return {
      name,
      alive: true,
      pid,
      uptimeMs,
      detail: open ? `pid ${pid} alive, :${RELAY_PORT} open` : `pid ${pid} alive, :${RELAY_PORT} closed`,
    };
  }
  try {
    const res = await fetchWithTimeout(deps.fetchImpl, `${deps.gatewayBase}/api/health`);
    return {
      name,
      alive: true,
      pid,
      uptimeMs,
      detail: res.ok ? `pid ${pid} alive, /api/health ok` : `pid ${pid} alive, /api/health -> HTTP ${res.status}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { name, alive: true, pid, uptimeMs, detail: `pid ${pid} alive, /api/health unreachable: ${reason}` };
  }
}

function formatUptime(uptimeMs: number | null): string {
  if (uptimeMs === null) return "-";
  const s = Math.floor(uptimeMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function formatTable(statuses: readonly ServiceStatus[], verbose: boolean, lastLines: Record<string, string[]>): string {
  const rows = statuses.map((s) => {
    const base = `${s.name}  ${s.alive ? "alive" : "dead"}  pid ${s.pid ?? "-"}  uptime ${formatUptime(s.uptimeMs)}  ${s.detail}`;
    if (!verbose) return base;
    const last = (lastLines[s.name] ?? []).filter((l) => l.trim() !== "").at(-1) ?? "";
    return last ? `${base}  log: ${last.slice(0, 120)}` : base;
  });
  return ["NAME  STATE  PID  UPTIME  DETAIL", ...rows].join("\n");
}

function formatJsonPayload(statuses: readonly ServiceStatus[]): string {
  return JSON.stringify(
    {
      ok: statuses.every((s) => s.alive),
      services: statuses.map((s) => ({
        name: s.name,
        alive: s.alive,
        pid: s.pid,
        uptimeMs: s.uptimeMs,
        detail: s.detail,
      })),
    },
    null,
    2,
  );
}

export function parseStatusArgs(rest: readonly string[]): { ok: true; options: StatusOptions } | { ok: false; message: string } {
  let json = false;
  let selfHeal = false;
  let verbose = false;
  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--self-heal") {
      selfHeal = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else {
      return { ok: false, message: `error: unknown option '${arg}'\n${COMMAND_HELP["status"]}` };
    }
  }
  return { ok: true, options: { json, selfHeal, verbose } };
}

/**
 * Run `zen status`. Returns the process exit code:
 * 0 healed-or-healthy, 1 still-down, 2 usage. Never throws.
 */
export async function runStatus(rest: readonly string[], deps?: StatusDeps): Promise<number> {
  const parsed = parseStatusArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const { json, selfHeal, verbose } = parsed.options;

  const pidDir = deps?.pidDir ?? resolvePidDir();
  const logDir = deps?.logDir ?? resolveLogDir();
  const live: LiveDeps = {
    pidDir,
    readPidFn: deps?.readPidFn ?? readPid,
    tcpProbe: deps?.tcpProbe ?? probeTcp,
    fetchImpl: deps?.fetchImpl ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init)),
    gatewayBase: deps?.gatewayBase ?? GATEWAY_BASE,
    now: deps?.now ?? Date.now,
  };
  const tailFn = deps?.tailFn ?? tailLog;
  const spawnFn: SpawnFn = deps?.spawnFn ?? ((cmd, args, opts) => spawnDetached(cmd, [...args], opts));
  const notifyFn = deps?.notifyFn ?? ((proc, lines) => notifyCrash(proc, lines));
  const specs = { ...defaultSpecs(), ...(deps?.specs ?? {}) };

  const lastLines: Record<string, string[]> = {};
  const readLast = (name: StatusService): string[] => {
    try {
      return tailFn(logDir, name, 20);
    } catch {
      return [];
    }
  };

  const statuses: ServiceStatus[] = [];
  for (const name of STATUS_SERVICES) {
    statuses.push(await checkService(live, name));
  }

  const healed: string[] = [];
  const failed: string[] = [];
  if (selfHeal) {
    for (const st of statuses) {
      if (st.alive) continue;
      const lines = readLast(st.name);
      lastLines[st.name] = lines;
      try {
        notifyFn(st.name, lines);
      } catch {
        // notify is best-effort; a toast failure must not block the heal.
      }
      try {
        const spec = specs[st.name];
        const pid = spawnFn(spec.cmd, spec.args, { name: st.name, logDir, pidDir });
        healed.push(`healed ${st.name} (pid ${pid})`);
      } catch (err) {
        failed.push(`failed ${st.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (verbose) {
    for (const name of STATUS_SERVICES) {
      if (lastLines[name] === undefined) lastLines[name] = readLast(name);
    }
  }

  if (json) {
    console.log(formatJsonPayload(statuses));
  } else {
    console.log(formatTable(statuses, verbose, lastLines));
  }
  for (const line of healed) console.log(line);
  for (const line of failed) console.log(line);

  const down = statuses.filter((s) => !s.alive).map((s) => s.name);
  if (down.length === 0) return 0;
  if (selfHeal) {
    const stillDown = down.filter((name) => !healed.some((h) => h.startsWith(`healed ${name} `)));
    return stillDown.length === 0 ? 0 : 1;
  }
  return 1;
}
