/**
 * Dashboard compat for `GET /dashboard/providers/opencode`.
 *
 * API-first: the JSON shape at `GET /api/dashboard/providers/opencode`
 * backs the minimal HTML page. Keyless provider — no auth prompts,
 * no key/password fields. Watcher compat stays on the existing
 * `GET /api/usage/proxy-logs` route (not duplicated here, only linked).
 */

import { OC_BASE_URL } from "@/registry/types";
import type { RegistryModel } from "@/registry/types";

export interface DashboardProviderModel {
  readonly id: string;
  readonly name: string;
  readonly targetFormat: string;
  readonly contextLength: number;
}

export interface DashboardProviderJson {
  readonly id: "opencode";
  readonly alias: "oc";
  readonly name: "OpenCode Free";
  readonly baseUrl: typeof OC_BASE_URL;
  readonly noAuth: true;
  readonly models: readonly DashboardProviderModel[];
}

/** Dashboard contract: keyless providers shown without auth prompts. */
export const NOAUTH_PROVIDERS: readonly DashboardProviderJson["id"][] = [
  "opencode",
] as const;

export const OPENCODE_PROVIDER_NAME = "OpenCode Free" as const;

/** Registry/autoparser models -> dashboard provider JSON (membership untouched). */
export function buildOpencodeProvider(
  models: readonly RegistryModel[],
): DashboardProviderJson {
  return {
    id: "opencode",
    alias: "oc",
    name: OPENCODE_PROVIDER_NAME,
    baseUrl: OC_BASE_URL,
    noAuth: true,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      targetFormat: model.targetFormat ?? "openai-chat",
      contextLength: model.contextLength,
    })),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal Hono HTML string: no framework, no CSS deps, no input fields. */
export function renderOpencodePage(provider: DashboardProviderJson): string {
  const items: string = provider.models
    .map(
      (model) =>
        `<li><code>${escapeHtml(model.id)}</code> — ${escapeHtml(model.name)} (${escapeHtml(model.targetFormat)})</li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(provider.name)} provider — opencode</title></head>
<body>
<h1>${escapeHtml(provider.name)} (opencode / oc)</h1>
<p>Provider id <code>opencode</code>, alias <code>oc</code>.</p>
<p>Status: <strong>no-auth</strong> — keyless provider, no auth prompt, no key required.</p>
<p>Upstream baseUrl <code>${escapeHtml(provider.baseUrl)}</code>.</p>
<h2>Free models (${provider.models.length})</h2>
<ul>${items}</ul>
<p>JSON: <a href="/api/dashboard/providers/opencode">/api/dashboard/providers/opencode</a></p>
<p>Watcher usage logs: <a href="/api/usage/proxy-logs">/api/usage/proxy-logs</a></p>
</body>
</html>`;
}
