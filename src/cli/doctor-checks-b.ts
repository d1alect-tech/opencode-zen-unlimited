/**
 * Doctor checks batch B (plan T6): slow/live checks.
 *
 * Ports (TCP connect), services (pidfile + gateway /api/health),
 * zen-endpoint (full chain GET /v1/models expecting oc/ ids), and
 * scheduler (schtasks oc-* tasks, warn-only). Every probe has a
 * <=3s timeout; offline services fail with a fixHint and never throw
 * (the framework isolates throws anyway).
 */
import { Socket } from "node:net";
import { readPid, resolvePidDir } from "../process/pidfile.ts";
import type { Check, CheckOutcome } from "./doctor-framework.ts";

/** Every network probe (TCP or HTTP) gives up after this long. */
export const PROBE_TIMEOUT_MS = 3000;

const GATEWAY_BASE = "http://127.0.0.1:20128";
const TASK_NAMES: readonly string[] = ["oc-singbox", "oc-relay", "oc-gateway"];

export interface ChecksBDeps {
  readonly tcpProbe?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  readonly pidDir?: string;
  readonly readPidFn?: (dir: string, name: string) => number | null;
  readonly fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  readonly queryScheduler?: () => Promise<string>;
  readonly gatewayBase?: string;
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
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Names of oc-* tasks currently registered. Empty when schtasks is missing. */
async function defaultQueryScheduler(): Promise<string> {
  const present: string[] = [];
  for (const name of TASK_NAMES) {
    try {
      const proc = Bun.spawnSync(["schtasks", "/Query", "/TN", name]);
      if (proc.exitCode === 0) present.push(name);
    } catch {
      // schtasks missing (non-Windows): treated as absent by the caller.
    }
  }
  return present.join("\n");
}

function portCheck(
  deps: Required<Pick<ChecksBDeps, "tcpProbe">>,
  port: number,
  service: string,
): Check {
  return {
    id: `port:${port}`,
    group: "Ports",
    run: async (): Promise<CheckOutcome> => {
      try {
        const open = await deps.tcpProbe("127.0.0.1", port, PROBE_TIMEOUT_MS);
        return open
          ? { result: "pass", detail: `${service} listening on ${port}` }
          : {
              result: "fail",
              detail: `${service} not listening on 127.0.0.1:${port}`,
              fixHint: `start services (${service} before dependents) or run 'zen setup'`,
            };
      } catch (err) {
        return {
          result: "fail",
          detail: `port ${port} probe error: ${err instanceof Error ? err.message : String(err)}`,
          fixHint: `start services (${service}) or run 'zen setup'`,
        };
      }
    },
  };
}

function pidCheck(
  deps: Required<Pick<ChecksBDeps, "pidDir" | "readPidFn">>,
  slot: string,
): CheckOutcome {
  const pid = deps.readPidFn(deps.pidDir, slot);
  return pid === null
    ? {
        result: "fail",
        detail: `${slot} pidfile missing or stale`,
        fixHint: "start services (order: sing-box, relay, gateway) or run 'zen setup'",
      }
    : { result: "pass", detail: `${slot} pid ${pid} alive` };
}

function modelIdsFrom(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data: unknown = (body as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry === "object" && entry !== null) {
      const id: unknown = (entry as Record<string, unknown>)["id"];
      if (typeof id === "string") ids.push(id);
    }
  }
  return ids;
}

export function createChecksB(deps: ChecksBDeps = {}): Check[] {
  const tcpProbe = deps.tcpProbe ?? probeTcp;
  const pidDir = deps.pidDir ?? resolvePidDir();
  const readPidFn = deps.readPidFn ?? readPid;
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init));
  const queryScheduler = deps.queryScheduler ?? defaultQueryScheduler;
  const gatewayBase = deps.gatewayBase ?? GATEWAY_BASE;
  const bound = { tcpProbe, pidDir, readPidFn };

  const port1090 = portCheck({ tcpProbe }, 1090, "relay");
  const port20128 = portCheck({ tcpProbe }, 20128, "gateway");

  const singBox: Check = {
    id: "service:sing-box",
    group: "Services",
    run: (): CheckOutcome => pidCheck(bound, "sing-box"),
  };
  const relay: Check = {
    id: "service:relay",
    group: "Services",
    run: (): CheckOutcome => pidCheck(bound, "relay"),
  };
  const gateway: Check = {
    id: "service:gateway",
    group: "Services",
    run: async (): Promise<CheckOutcome> => {
      const pid = pidCheck(bound, "gateway");
      if (pid.result === "fail") return pid;
      try {
        const res = await fetchWithTimeout(fetchImpl, `${gatewayBase}/api/health`);
        if (res.ok) return { result: "pass", detail: "gateway pid alive, /api/health ok" };
        return {
          result: "fail",
          detail: `gateway /api/health -> HTTP ${res.status}`,
          fixHint: "restart the gateway or run 'zen setup'",
        };
      } catch (err) {
        return {
          result: "fail",
          detail: `gateway /api/health unreachable: ${err instanceof Error ? err.message : String(err)}`,
          fixHint: "restart the gateway or run 'zen setup'",
        };
      }
    },
  };
  const zenEndpoint: Check = {
    id: "zen-endpoint",
    group: "Services",
    run: async (): Promise<CheckOutcome> => {
      try {
        const res = await fetchWithTimeout(fetchImpl, `${gatewayBase}/v1/models`);
        if (!res.ok) {
          return {
            result: "fail",
            detail: `GET /v1/models -> HTTP ${res.status}`,
            fixHint: "start services (gateway + relay + egress) or run 'zen setup'",
          };
        }
        const ids = modelIdsFrom((await res.json()) as unknown);
        return ids.some((id) => id.startsWith("oc/"))
          ? { result: "pass", detail: `gateway serves ${ids.length} model ids incl. oc/` }
          : {
              result: "fail",
              detail: "GET /v1/models returned no oc/ model ids",
              fixHint: "start services (gateway + relay + egress) or run 'zen setup'",
            };
      } catch (err) {
        return {
          result: "fail",
          detail: `GET /v1/models unreachable: ${err instanceof Error ? err.message : String(err)}`,
          fixHint: "start services (gateway + relay + egress) or run 'zen setup'",
        };
      }
    },
  };
  const scheduler: Check = {
    id: "scheduler",
    group: "Services",
    run: async (): Promise<CheckOutcome> => {
      try {
        const output = await queryScheduler();
        const missing = TASK_NAMES.filter((name) => !output.includes(name));
        return missing.length === 0
          ? { result: "pass", detail: "oc-singbox, oc-relay, oc-gateway scheduled" }
          : {
              result: "warn",
              detail: `missing scheduler tasks: ${missing.join(", ")}`,
              fixHint: "register tasks: run scripts/install-scheduler.ps1 from elevated PowerShell",
            };
      } catch (err) {
        return {
          result: "warn",
          detail: `scheduler query failed: ${err instanceof Error ? err.message : String(err)}`,
          fixHint: "register tasks: run scripts/install-scheduler.ps1 from elevated PowerShell",
        };
      }
    },
  };
  return [port1090, port20128, singBox, relay, gateway, zenEndpoint, scheduler];
}

/** Default live wiring for `zen doctor` (append-only with CHECKS_A in doctor.ts). */
export const CHECKS_B: readonly Check[] = createChecksB();
