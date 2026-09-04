import { describe, expect, test } from "bun:test";
import { formatHelp } from "../src/cli/help.ts";
import { isSubcommand, parseCliArgs } from "../src/cli/parser.ts";
import { runCli } from "../src/cli/dispatch.ts";

describe("cli skeleton routing (argv = process.argv.slice(2))", () => {
  test("unknown subcommand -> exit 2 + usage", () => {
    const parsed = parseCliArgs(["bogus"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.exitCode).toBe(2);
      expect(parsed.message).toMatch(/usage/i);
    }
  });

  test("--help lists all commands", () => {
    const out = formatHelp();
    for (const cmd of ["doctor", "status", "setup", "add-sub", "logs"]) {
      expect(out).toContain(cmd);
    }
  });

  test("bare --help parses as help", () => {
    const parsed = parseCliArgs(["--help"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.help).toBe(true);
    }
  });

  test("slice(2) routing: known subcommand dispatches", () => {
    // Simulates: argv[0]=bun (compiled) so entry uses process.argv.slice(2).
    const argv = ["status"];
    const parsed = parseCliArgs(argv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.subcommand).toBe("status");
    }
  });

  test("per-command --help flag parses", () => {
    const parsed = parseCliArgs(["doctor", "--help"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.subcommand).toBe("doctor");
      expect(parsed.help).toBe(true);
    }
  });

  test("per-command unknown option -> exit 2", () => {
    const parsed = parseCliArgs(["status", "--nope"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.exitCode).toBe(2);
    }
  });

  test("stubs return exit 2 (not implemented yet)", async () => {
    // Only commands still without real logic; doctor/logs/status/setup are implemented.
    for (const cmd of ["add-sub"] as const) {
      expect(isSubcommand(cmd)).toBe(true);
      const code = await runCli([cmd]);
      expect(code).toBe(2);
    }
  });

  test("logs without proc exits 2 with usage", async () => {
    const code = await runCli(["logs"]);
    expect(code).toBe(2);
  });
});
