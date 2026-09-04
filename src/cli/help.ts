import type { Subcommand } from "./parser.ts";
import { COMMAND_HELP, USAGE } from "./parser.ts";

/**
 * Hand-written help text. node:util.parseArgs generates none,
 * so every command documents itself here.
 */
export function formatHelp(subcommand?: Subcommand): string {
  if (subcommand !== undefined) {
    return COMMAND_HELP[subcommand];
  }
  return USAGE;
}
