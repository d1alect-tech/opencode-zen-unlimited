import { parseArgs } from "node:util";
import { COMMAND_HELP } from "../parser.ts";

/** Gateway base mirrors status/doctor probes (PORT is loopback-only). */
const GATEWAY_BASE = "http://127.0.0.1:20128";

/** Network probes give up after this long (mirrors status/doctor). */
export const POOL_PROBE_TIMEOUT_MS = 3000;

export interface PoolEgressRow {
  readonly egressUrl: string;
  readonly healthy: boolean;
  readonly benchedMsRemaining: number;
}

export interface PoolState {
  readonly total: number;
  readonly healthy: number;
  readonly entries: readonly PoolEgressRow[];
}

export interface PoolDeps {
  readonly fetchImpl?: (
    url: string,
    init?: { method?: string; signal?: AbortSignal },
  ) => Promise<Response>;
  readonly gatewayBase?: string;
}

async function fetchWithTimeout(
  fetchImpl: (
    url: string,
    init?: { method?: string; signal?: AbortSignal },
  ) => Promise<Response>,
  url: string,
  method: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POOL_PROBE_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { method, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 899000 -> "14m59s", 45000 -> "45s" (bench countdowns, not timestamps). */
export function formatBenchRemaining(ms: number): string {
  const totalSec: number = Math.max(0, Math.ceil(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes: number = Math.floor(totalSec / 60);
  return `${minutes}m${String(totalSec % 60).padStart(2, "0")}s`;
}

function isPoolState(value: unknown): value is PoolState {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["total"] === "number" &&
    typeof rec["healthy"] === "number" &&
    Array.isArray(rec["entries"])
  );
}

/**
 * `zen pool [--json] [--reset]`.
 * Shows per-egress bench state from the live gateway (`GET /api/pool`):
 * `ok <url>` vs `bench <url> <remaining>` plus a `pool: H/T healthy`
 * summary. `--reset` POSTs `/api/pool/reset` first (clears quarantines
 * without a restart — the same relief a restart gave, minus downtime).
 * Gateway down -> stderr, exit 1. Usage errors -> exit 2.
 */
export async function runPool(
  rest: readonly string[],
  deps?: PoolDeps,
): Promise<number> {
  let json = false;
  let reset = false;
  try {
    const parsed = parseArgs({
      args: [...rest],
      strict: true,
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h", default: false },
        json: { type: "boolean", default: false },
        reset: { type: "boolean", default: false },
      },
    });
    if (parsed.values["help"] === true) {
      console.log(COMMAND_HELP["pool"]);
      return 0;
    }
    if (parsed.positionals.length > 0) {
      console.error(
        `error: unexpected argument '${parsed.positionals[0] ?? ""}'\n${COMMAND_HELP["pool"]}`,
      );
      return 2;
    }
    json = parsed.values["json"] === true;
    reset = parsed.values["reset"] === true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`error: ${detail}\n${COMMAND_HELP["pool"]}`);
    return 2;
  }

  const fetchImpl = deps?.fetchImpl ?? fetch;
  const base = deps?.gatewayBase ?? GATEWAY_BASE;

  async function getState(): Promise<PoolState | null> {
    let res: Response;
    try {
      res = await fetchWithTimeout(fetchImpl, `${base}/api/pool`, "GET");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`error: gateway unreachable at ${base}: ${detail}`);
      return null;
    }
    if (!res.ok) {
      console.error(`error: GET /api/pool -> HTTP ${res.status}`);
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      console.error("error: GET /api/pool returned non-JSON");
      return null;
    }
    if (!isPoolState(body)) {
      console.error("error: GET /api/pool returned an unexpected shape");
      return null;
    }
    return body;
  }

  let cleared = 0;
  if (reset) {
    let res: Response;
    try {
      res = await fetchWithTimeout(fetchImpl, `${base}/api/pool/reset`, "POST");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`error: gateway unreachable at ${base}: ${detail}`);
      return 1;
    }
    if (!res.ok) {
      console.error(`error: POST /api/pool/reset -> HTTP ${res.status}`);
      return 1;
    }
    try {
      const body = (await res.json()) as { cleared?: unknown };
      cleared = typeof body.cleared === "number" ? body.cleared : 0;
    } catch {
      cleared = 0;
    }
  }

  const state = await getState();
  if (state === null) return 1;

  if (json) {
    console.log(
      reset
        ? JSON.stringify({ reset: { cleared }, ...state })
        : JSON.stringify(state),
    );
    return 0;
  }
  if (reset) console.log(`cleared ${cleared} bench(es)`);
  for (const entry of state.entries) {
    console.log(
      entry.healthy
        ? `ok ${entry.egressUrl}`
        : `bench ${entry.egressUrl} ${formatBenchRemaining(entry.benchedMsRemaining)}`,
    );
  }
  console.log(`pool: ${state.healthy}/${state.total} healthy`);
  return 0;
}
