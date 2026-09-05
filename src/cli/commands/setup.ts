/**
 * `zen setup [--dry-run] [--yes]` (plan T10).
 *
 * First-run setup, idempotent (rerun-safe):
 * 1. ensure the %LOCALAPPDATA%/zen dirs (pid + log dirs),
 * 2. sing-box binary check (doctor batch A convention: ./bin first,
 *    then PATH; pinned >= 1.14.0; no auto-download without --yes),
 * 3. write the .env skeleton from .env.example when missing
 *    (PORT/EGRESS_UPSTREAMS/EGRESS_SUB_URL placeholders, never
 *    overwritten without --yes),
 * 4. emit sing-box/config.json from sing-box/config.example.json
 *    when missing (never overwritten without --yes),
 * 5. register scheduler tasks via scripts/install-zen-stack.ps1
 *    (oc-singbox, oc-relay, oc-gateway, oc-watchdog; self-elevates
 *    via UAC, single-shot XML import as SYSTEM, transcript to
 *    scripts/install-zen-stack.log),
 * 6. print next steps (`zen add-sub <url>`, `zen doctor`).
 *
 * `--dry-run` prints the full plan, changes nothing, exits 0.
 * Secret values are never printed — only key names and paths.
 * Exit codes: 0 done/plan, 1 setup failure, 2 usage. Never throws
 * for usage errors; unexpected failures are caught and reported.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_HELP } from "../parser.ts";
import { resolveLogDir } from "../../process/logs.ts";
import { resolvePidDir } from "../../process/pidfile.ts";

/** sing-box floor: grill decision pins download-on-install to >= 1.14.0. */
export const SINGBOX_MIN: readonly [number, number, number] = [1, 14, 0];

const SCHEDULER_TASKS: readonly string[] = ["oc-singbox", "oc-relay", "oc-gateway"];

export interface SetupRunResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export interface SetupDeps {
  readonly projectRoot?: string;
  readonly pidDir?: string;
  readonly logDir?: string;
  readonly platform?: string;
  readonly mkdirFn?: (dir: string) => void;
  readonly fileExists?: (path: string) => boolean;
  readonly readFile?: (path: string) => string | undefined;
  readonly writeFile?: (path: string, content: string) => void;
  readonly runCmd?: (cmd: string, args: readonly string[]) => SetupRunResult;
  readonly execScheduler?: (script: string, args: readonly string[]) => SetupRunResult;
}

export interface SetupOptions {
  readonly dryRun: boolean;
  readonly yes: boolean;
}

function defaultRunCmd(cmd: string, args: readonly string[]): SetupRunResult {
  try {
    const out = spawnSync(cmd, [...args], { encoding: "utf8", timeout: 10_000 });
    const stdout = typeof out.stdout === "string" ? out.stdout : "";
    return { ok: out.status === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function defaultExecScheduler(script: string, args: readonly string[]): SetupRunResult {
  try {
    const out = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const stdout = typeof out.stdout === "string" ? out.stdout : "";
    return { ok: out.status === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

interface ResolvedDeps {
  readonly projectRoot: string;
  readonly pidDir: string;
  readonly logDir: string;
  readonly platform: string;
  readonly mkdirFn: (dir: string) => void;
  readonly fileExists: (path: string) => boolean;
  readonly readFile: (path: string) => string | undefined;
  readonly writeFile: (path: string, content: string) => void;
  readonly runCmd: (cmd: string, args: readonly string[]) => SetupRunResult;
  readonly execScheduler: (script: string, args: readonly string[]) => SetupRunResult;
}

function resolveDeps(deps: SetupDeps = {}): ResolvedDeps {
  const projectRoot = deps.projectRoot ?? process.cwd();
  return {
    projectRoot,
    pidDir: deps.pidDir ?? resolvePidDir(),
    logDir: deps.logDir ?? resolveLogDir(),
    platform: deps.platform ?? process.platform,
    mkdirFn:
      deps.mkdirFn ??
      ((dir: string) => {
        mkdirSync(dir, { recursive: true });
      }),
    fileExists: deps.fileExists ?? existsSync,
    readFile:
      deps.readFile ??
      ((path: string) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      }),
    writeFile:
      deps.writeFile ??
      ((path: string, content: string) => {
        writeFileSync(path, content, "utf8");
      }),
    runCmd: deps.runCmd ?? defaultRunCmd,
    execScheduler: deps.execScheduler ?? defaultExecScheduler,
  };
}

function parseTriplet(text: string): readonly [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (m === null) return undefined;
  const major = Number.parseInt(m[1] ?? "0", 10);
  const minor = Number.parseInt(m[2] ?? "0", 10);
  const patch = Number.parseInt(m[3] ?? "0", 10);
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

export function parseSetupArgs(rest: readonly string[]): { ok: true; options: SetupOptions } | { ok: false; message: string } {
  let dryRun = false;
  let yes = false;
  for (const arg of rest) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yes") {
      yes = true;
    } else {
      return { ok: false, message: `error: unknown option '${arg}'\n${COMMAND_HELP["setup"]}` };
    }
  }
  return { ok: true, options: { dryRun, yes } };
}

interface BinaryProbe {
  readonly found: boolean;
  readonly where: string;
  readonly version: readonly [number, number, number] | undefined;
  readonly versionText: string;
}

function probeSingBox(deps: ResolvedDeps): BinaryProbe {
  const local = join(deps.projectRoot, "bin", deps.platform === "win32" ? "sing-box.exe" : "sing-box");
  if (deps.fileExists(local)) {
    const probe = deps.runCmd(local, ["--version"]);
    const version = parseTriplet(probe.stdout);
    return { found: true, where: local, version, versionText: probe.stdout.trim().split("\n")[0] ?? "" };
  }
  const probeCmd = deps.platform === "win32" ? "where" : "which";
  const located = deps.runCmd(probeCmd, ["sing-box"]);
  if (!located.ok) {
    return { found: false, where: "", version: undefined, versionText: "" };
  }
  const probe = deps.runCmd("sing-box", ["--version"]);
  const version = parseTriplet(probe.stdout);
  return { found: true, where: "sing-box on PATH", version, versionText: probe.stdout.trim().split("\n")[0] ?? "" };
}

function singBoxFixHint(): string {
  return "Install sing-box >= 1.14.0: https://sing-box.sagernet.org/installation/ or place the binary at ./bin/sing-box.exe";
}

function emitPlan(deps: ResolvedDeps, envPath: string, configPath: string, examplePath: string, scriptPath: string): void {
  console.log("zen setup plan (dry run, no changes):");
  console.log(`- ensure dir: ${deps.pidDir}`);
  console.log(`- ensure dir: ${deps.logDir}`);
  console.log(`- check sing-box >= ${formatTriplet(SINGBOX_MIN)} (./bin or PATH)`);
  console.log(`- write .env skeleton (PORT, EGRESS_UPSTREAMS, EGRESS_SUB_URL placeholders): ${envPath}`);
  console.log(`- emit sing-box config from ${examplePath}: ${configPath}`);
  console.log(`- register scheduler tasks (${SCHEDULER_TASKS.join(", ")}): ${scriptPath}`);
  console.log("- next: zen add-sub <url>  # add a subscription link");
  console.log("- next: zen doctor  # verify gateway, relay and egress health");
}

/**
 * Run `zen setup`. Returns the process exit code:
 * 0 done/plan, 1 setup failure, 2 usage. Never throws.
 */
export async function runSetup(rest: readonly string[], deps?: SetupDeps): Promise<number> {
  const parsed = parseSetupArgs(rest);
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const { dryRun, yes } = parsed.options;
  const resolved = resolveDeps(deps);
  const envPath = join(resolved.projectRoot, ".env");
  const examplePath = join(resolved.projectRoot, ".env.example");
  const singboxExample = join(resolved.projectRoot, "sing-box", "config.example.json");
  const singboxConfig = join(resolved.projectRoot, "sing-box", "config.json");
  const scriptPath = join(resolved.projectRoot, "scripts", "install-zen-stack.ps1");

  if (dryRun) {
    emitPlan(resolved, envPath, singboxConfig, singboxExample, scriptPath);
    return 0;
  }

  try {
    // (1) dirs.
    for (const dir of [resolved.pidDir, resolved.logDir]) {
      resolved.mkdirFn(dir);
      console.log(`ensure dir ${dir}: ok`);
    }

    // (2) sing-box binary check (doctor batch A convention, pinned >= 1.14.0).
    const probe = probeSingBox(resolved);
    if (!probe.found) {
      if (!yes) {
        console.error(`error: sing-box not resolvable (PATH or ./bin)\nfix: ${singBoxFixHint()} (or re-run with --yes to proceed anyway)`);
        return 1;
      }
      console.log(`warn: sing-box missing — download sing-box >= ${formatTriplet(SINGBOX_MIN)} then re-run zen doctor`);
    } else if (probe.version === undefined || !gte(probe.version, SINGBOX_MIN)) {
      const detail = probe.version === undefined ? "unreadable version" : `version ${formatTriplet(probe.version)} below minimum ${formatTriplet(SINGBOX_MIN)}`;
      if (!yes) {
        console.error(`error: sing-box ${detail}\nfix: ${singBoxFixHint()} (or re-run with --yes to proceed anyway)`);
        return 1;
      }
      console.log(`warn: sing-box ${detail} — continuing with --yes`);
    } else {
      console.log(`check sing-box ${formatTriplet(probe.version)} (${probe.where}): ok`);
    }

    // (3) .env skeleton (key names only — never print values).
    if (resolved.fileExists(envPath) && !yes) {
      console.log(`skip: ${envPath} exists (re-run with --yes to overwrite)`);
    } else {
      const skeleton = resolved.readFile(examplePath);
      if (skeleton === undefined) {
        console.error(`error: missing ${examplePath}\nfix: restore .env.example from git (git checkout -- .env.example)`);
        return 1;
      }
      const overwrote = resolved.fileExists(envPath) && yes;
      resolved.writeFile(envPath, skeleton);
      console.log(`write ${envPath} (.env skeleton: PORT, EGRESS_UPSTREAMS, EGRESS_SUB_URL): ${overwrote ? "overwrote with --yes" : "created"}`);
    }

    // (4) sing-box config from placeholders.
    if (resolved.fileExists(singboxConfig) && !yes) {
      console.log(`skip: ${singboxConfig} exists (re-run with --yes to overwrite)`);
    } else {
      const example = resolved.readFile(singboxExample);
      if (example === undefined) {
        console.error(`error: missing ${singboxExample}\nfix: restore sing-box/config.example.json from git`);
        return 1;
      }
      const overwrote = resolved.fileExists(singboxConfig) && yes;
      resolved.writeFile(singboxConfig, example);
      console.log(`write ${singboxConfig} (from config.example.json placeholders): ${overwrote ? "overwrote with --yes" : "created"}`);
    }

    // (5) scheduler tasks (Windows-only; the ps1 is owned by T13).
    if (resolved.platform !== "win32") {
      console.log("skip: scheduler registration (Windows-only, run scripts/install-zen-stack.ps1 on Windows)");
    } else {
      const result = resolved.execScheduler(scriptPath, []);
      if (!result.ok) {
        console.error(
          `error: scheduler registration failed\nfix: run from elevated PowerShell: powershell -ExecutionPolicy Bypass -File ${scriptPath}`,
        );
        return 1;
      }
      console.log(`register scheduler tasks (${SCHEDULER_TASKS.join(", ")}): ok`);
    }

    // (6) next steps (add-sub fetch logic is T11 — pointer only).
    console.log("next: zen add-sub <url>  # add a subscription link");
    console.log("next: zen doctor  # verify gateway, relay and egress health");
    console.log("setup complete");
    return 0;
  } catch (err) {
    console.error(`error: setup failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
