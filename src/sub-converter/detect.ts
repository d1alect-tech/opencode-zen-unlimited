/** Content sniffing: branch on payload shape, never on extension. */

export type SubFormat = "json" | "clash-yaml" | "base64-uri" | "uri-list";

const BASE64_BLOB_RE = /^[A-Za-z0-9+/=_-]{32,}\s*$/;

function looksLikeBase64(blob: string): boolean {
  const compact = blob.replace(/\s+/g, "");
  if (compact.length < 32 || compact.length % 4 === 1) return false;
  return BASE64_BLOB_RE.test(blob.trim());
}

export function decodeBase64Text(blob: string): string {
  const compact = blob.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(compact, "base64").toString("utf-8");
}

/** Detect the subscription payload encoding. */
export function detectFormat(raw: string): SubFormat {
  const text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // fall through to content sniffing
    }
  }
  if (/^\s*proxies\s*:/m.test(text)) return "clash-yaml";
  if (!text.includes("://") && looksLikeBase64(text)) {
    try {
      const decoded = decodeBase64Text(text);
      if (decoded.includes("://")) return "base64-uri";
    } catch {
      // not decodable: treat as raw list
    }
  }
  return "uri-list";
}

/** Split a URI list payload into candidate lines; drops blanks and // comments. */
export function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("#"));
}
