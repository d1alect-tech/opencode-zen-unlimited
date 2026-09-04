/** SSRF-guarded subscription fetch. Only http(s); blocks loopback/private/metadata. */

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
export const CLASHMETA_UA = "clash.meta/v1";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
  "instance-data-compute",
]);

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function ipv4Blocked(host: string): boolean {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "localhost") return true;
  if (isIpv4(host)) return ipv4Blocked(host);
  if (host.includes(":")) return true; // other literal IPv6: refuse without resolver
  return false;
}

/** Validate the subscription URL before any network access. Throws on rejection. */
export function validateSubUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid subscription URL: not parseable`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`invalid subscription URL: only http(s) allowed (got ${url.protocol})`);
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`blocked subscription target: ${url.hostname} is not fetchable`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`blocked subscription URL: embedded credentials are not allowed`);
  }
  return url;
}

export interface FetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** GET the subscription body. Browser UA first, clashmeta fallback. Redirects followed. */
export async function fetchSub(url: string, opts: FetchOptions = {}): Promise<string> {
  const target = validateSubUrl(url);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const impl = opts.fetchImpl ?? fetch;
  const attempts = [BROWSER_UA, CLASHMETA_UA];
  let lastError: unknown = null;
  for (const ua of attempts) {
    try {
      const res = await impl(target.toString(), {
        headers: { "user-agent": ua, accept: "*/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastError = new Error(`subscription fetch failed: http ${res.status}`);
        continue;
      }
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("subscription fetch failed");
}
