/**
 * Doctor checks batch A: offline-safe, cheap -> slow.
 *
 * Runtime gates (bun/node/bunx) first, then .env file + key presence,
 * EGRESS_UPSTREAMS parse (reuses the gateway dispatcher convention),
 * secret-placeholder audit, sing-box binary, and a warn-only Windows
 * firewall query last (slowest spawn). Details carry counts and key
 * names only — never secret values.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEgressUpstreams } from "../gateway/dispatcher.ts";
import type { Check, CheckOutcome } from "./doctor-framework.ts";

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export type RunCmd = (cmd: string, args: readonly string[]) => RunResult;

export interface BatchAChecksDeps {
  readonly runCmd?: RunCmd;
  readonly readEnvFile?: () => string | undefined;
  readonly fileExists?: (path: string) => boolean;
  readonly platform?: string;
  readonly env?: Record<string, string | undefined>;
  readonly projectRoot?: string;
}

const BUN_MIN: readonly [number, number, number] = [1, 3, 14];
const NODE_MIN: readonly [number, number, number] = [22, 0, 0];

const SECRET_KEYS: readonly string[] = ["EGRESS_SUB_URL", "HY2_PASSWORD", "RR_WATCH_TOKEN"];

function defaultRunCmd(cmd: string, args: readonly string[]): RunResult {
  try {
    const out = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 10_000 });
    const stdout = typeof out.stdout === "string" ? out.stdout : "";
    return { ok: out.status === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function parseTriplet(text: string): readonly [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (m === null) return undefined;
  const parts = [m[1], m[2], m[3]].map((p) => Number.parseInt(p ?? "0", 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return undefined;
  return [major, minor, patch];
}

function gte(actual: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const a = actual[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function formatTriplet(v: readonly [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`;
}

/** Minimal KEY=VALUE parse (no expansion): comments + blanks skipped, quotes stripped. */
export function parseDotEnv(text: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    record[key] = value;
  }
  return record;
}

function resolveDeps(deps: BatchAChecksDeps = {}): {
  readonly runCmd: RunCmd;
  readonly readEnvFile: () => string | undefined;
  readonly fileExists: (path: string) => boolean;
  readonly platform: string;
  readonly processEnv: Record<string, string | undefined>;
  readonly projectRoot: string;
} {
  const projectRoot = deps.projectRoot ?? process.cwd();
  return {
    runCmd: deps.runCmd ?? defaultRunCmd,
    readEnvFile:
      deps.readEnvFile ??
      (() => {
        try {
          return readFileSync(join(projectRoot, ".env"), "utf8");
        } catch {
          return undefined;
        }
      }),
    fileExists: deps.fileExists ?? existsSync,
    platform: deps.platform ?? process.platform,
    processEnv: deps.env ?? process.env,
    projectRoot,
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

/** File values underlay, real env wins. */
function mergedEnv(resolved: Resolved): Record<string, string | undefined> {
  const raw = resolved.readEnvFile();
  const file = raw === undefined ? {} : parseDotEnv(raw);
  return { ...file, ...resolved.processEnv };
}

function versionGate(
  resolved: Resolved,
  cmd: string,
  min: readonly [number, number, number],
  fixHint: string,
): CheckOutcome {
  const probe = resolved.runCmd(cmd, ["--version"]);
  const version = parseTriplet(probe.stdout);
  if (!probe.ok || version === undefined) {
    return { result: "fail", detail: `${cmd} not found or unreadable`, fixHint };
  }
  if (!gte(version, min)) {
    return {
      result: "fail",
      detail: `${cmd} ${formatTriplet(version)} below minimum ${formatTriplet(min)}`,
      fixHint,
    };
  }
  return { result: "pass", detail: `${cmd} ${formatTriplet(version)}` };
}

function checkBunRuntime(resolved: Resolved): Check {
  return {
    id: "bun-runtime",
    group: "Runtime",
    run: () =>
      versionGate(
        resolved,
        "bun",
        BUN_MIN,
        "Install Bun >= 1.3.14: https://bun.sh (Windows: irm bun.sh/install.ps1 | iex)",
      ),
  };
}

function checkNodeRuntime(resolved: Resolved): Check {
  return {
    id: "node-runtime",
    group: "Runtime",
    run: () =>
      versionGate(
        resolved,
        "node",
        NODE_MIN,
        "Install Node.js >= 22: https://nodejs.org (winget install OpenJS.NodeJS.LTS)",
      ),
  };
}

function checkPackageManager(resolved: Resolved): Check {
  return {
    id: "package-manager",
    group: "Runtime",
    run: () => {
      const probe = resolved.runCmd("bunx", ["--version"]);
      const version = parseTriplet(probe.stdout);
      if (!probe.ok || version === undefined) {
        return {
          result: "fail",
          detail: "bunx not resolvable on PATH",
          fixHint: "bunx ships with Bun >= 1.3.14 — reinstall Bun: https://bun.sh",
        };
      }
      return { result: "pass", detail: `bunx ${formatTriplet(version)}` };
    },
  };
}

function checkConfigEnv(resolved: Resolved): Check {
  return {
    id: "config-env",
    group: "Config",
    run: () => {
      const raw = resolved.readEnvFile();
      if (raw === undefined) {
        return {
          result: "fail",
          detail: "missing .env file",
          fixHint: "Copy .env.example to .env and fill required keys (see .env.example)",
        };
      }
      const env = mergedEnv(resolved);
      const missing: string[] = [];
      if ((env["PORT"] ?? "").length === 0) missing.push("PORT");
      if (!("EGRESS_UPSTREAMS" in env)) missing.push("EGRESS_UPSTREAMS");
      if (missing.length > 0) {
        return {
          result: "fail",
          detail: `missing key(s): ${missing.join(", ")}`,
          fixHint: "Add the missing key(s) to .env — see .env.example for the documented defaults",
        };
      }
      return { result: "pass", detail: ".env with PORT + EGRESS_UPSTREAMS" };
    },
  };
}

function checkEgressUpstreams(resolved: Resolved): Check {
  return {
    id: "egress-upstreams",
    group: "Config",
    run: () => {
      const env = mergedEnv(resolved);
      const list = parseEgressUpstreams(env);
      if (list.length === 0) {
        const raw = (env["EGRESS_UPSTREAMS"] ?? "").trim();
        if (raw.length === 0) {
          return {
            result: "warn",
            detail: "EGRESS_UPSTREAMS empty — direct connection mode",
            fixHint:
              "Set EGRESS_UPSTREAMS=socks5h://127.0.0.1:1081,... in .env for pool routing (see .env.example)",
          };
        }
        return {
          result: "fail",
          detail: "EGRESS_UPSTREAMS has entries but 0 valid URL(s)",
          fixHint:
            "Fix EGRESS_UPSTREAMS in .env: comma-separated URL list, e.g. socks5h://127.0.0.1:1081,socks5h://127.0.0.1:1082",
        };
      }
      const malformed = list.filter((entry) => {
        try {
          new URL(entry);
          return false;
        } catch {
          return true;
        }
      });
      if (malformed.length > 0) {
        return {
          result: "fail",
          detail: `${malformed.length} of ${list.length} upstream(s) malformed`,
          fixHint:
            "Fix EGRESS_UPSTREAMS in .env: comma-separated URL list, e.g. socks5h://127.0.0.1:1081,socks5h://127.0.0.1:1082",
        };
      }
      return { result: "pass", detail: `${list.length} upstream(s) configured` };
    },
  };
}

function checkConfigSecrets(resolved: Resolved): Check {
  return {
    id: "config-secrets",
    group: "Config",
    run: () => {
      const raw = resolved.readEnvFile();
      if (raw === undefined) {
        return { result: "warn", detail: "no .env to audit" };
      }
      const file = parseDotEnv(raw);
      const placeholders = SECRET_KEYS.filter((key) => {
        const value = file[key] ?? "";
        return value.length === 0 || value.startsWith("YOUR_") || value.startsWith("<fill");
      });
      if (placeholders.length > 0) {
        return {
          result: "warn",
          detail: `placeholder secret(s): ${placeholders.join(", ")}`,
          fixHint: "Set real values in .env (env-only, never commit) — generate with: openssl rand -hex 32",
        };
      }
      return { result: "pass", detail: `${SECRET_KEYS.length} secret(s) configured` };
    },
  };
}

function checkSingBox(resolved: Resolved): Check {
  return {
    id: "binary:sing-box",
    group: "Binaries",
    run: () => {
      const local = join(resolved.projectRoot, "bin", resolved.platform === "win32" ? "sing-box.exe" : "sing-box");
      if (resolved.fileExists(local)) {
        return { result: "pass", detail: "sing-box in ./bin" };
      }
      const probeCmd = resolved.platform === "win32" ? "where" : "which";
      const probe = resolved.runCmd(probeCmd, ["sing-box"]);
      if (probe.ok) {
        return { result: "pass", detail: "sing-box on PATH" };
      }
      return {
        result: "fail",
        detail: "sing-box not resolvable (PATH or ./bin)",
        fixHint:
          "Install sing-box: https://sing-box.sagernet.org/installation/ or place the binary at ./bin/sing-box.exe",
      };
    },
  };
}

export function checkFirewall(deps: BatchAChecksDeps = {}): Check {
  const resolved = resolveDeps(deps);
  return {
    id: "firewall",
    group: "Services",
    run: () => {
      if (resolved.platform !== "win32") {
        return { result: "warn", detail: "non-Windows platform — firewall query skipped" };
      }
      const probe = resolved.runCmd("netsh", ["advfirewall", "show", "currentprofile", "state"]);
      if (!probe.ok) {
        return {
          result: "warn",
          detail: "firewall state unreadable — skipped",
          fixHint: 'Query manually: netsh advfirewall show currentprofile state (warn-only, no action required)',
        };
      }
      const on = /state\s+on/i.test(probe.stdout);
      if (on) {
        return {
          result: "warn",
          detail: "Windows Firewall ON — allow inbound TCP 20128 (gateway) + 1090 (relay)",
          fixHint:
            'Allow the gateway: netsh advfirewall firewall add rule name="zen-gateway" dir=in action=allow protocol=TCP localport=20128',
        };
      }
      return { result: "warn", detail: "Windows Firewall profile OFF — no rule needed" };
    },
  };
}

/** Batch A in cheap -> slow order. Slowest spawn (firewall) goes last. */
export function createBatchAChecks(deps: BatchAChecksDeps = {}): readonly Check[] {
  const resolved = resolveDeps(deps);
  return [
    checkBunRuntime(resolved),
    checkNodeRuntime(resolved),
    checkPackageManager(resolved),
    checkConfigEnv(resolved),
    checkEgressUpstreams(resolved),
    checkConfigSecrets(resolved),
    checkSingBox(resolved),
    checkFirewall(deps),
  ];
}

/** Live checks used by `zen doctor`. */
export const BATCH_A_CHECKS: readonly Check[] = createBatchAChecks();
