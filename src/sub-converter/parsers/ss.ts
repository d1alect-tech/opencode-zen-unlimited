import type { NormalizedNode } from "../types.ts";
import { decodeBase64Text } from "../detect.ts";

function splitMethodPassword(userinfo: string): { method: string; password: string } {
  const idx = userinfo.lastIndexOf(":");
  if (idx <= 0) throw new Error("invalid ss link: userinfo is not method:password");
  const method = userinfo.slice(0, idx);
  const password = userinfo.slice(idx + 1);
  if (method === "" || password === "") throw new Error("invalid ss link: empty method or password");
  return { method, password };
}

/**
 * Shadowsocks links, two wire forms:
 * - sip002: ss://base64(method:password)@host:port#tag
 * - legacy: ss://base64(method:password@host:port)#tag
 */
export function parseSs(line: string): NormalizedNode {
  const withoutScheme = line.replace(/^ss:\/\//i, "");
  const hashIdx = withoutScheme.indexOf("#");
  const tag = hashIdx >= 0 ? decodeURIComponent(withoutScheme.slice(hashIdx + 1)) : undefined;
  const body = (hashIdx >= 0 ? withoutScheme.slice(0, hashIdx) : withoutScheme).trim();

  if (body.includes("@")) {
    const atIdx = body.lastIndexOf("@");
    const encUser = body.slice(0, atIdx);
    const hostPort = body.slice(atIdx + 1);
    let userinfo: string;
    try {
      userinfo = decodeBase64Text(encUser);
    } catch {
      userinfo = decodeURIComponent(encUser);
    }
    const { method, password } = splitMethodPassword(userinfo);
    const m = hostPort.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)\/?$/);
    if (!m) throw new Error("invalid ss link: bad host:port");
    const host = (m[1] ?? m[2] ?? "").trim();
    const port = Number(m[3]);
    if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("invalid ss link: bad host:port");
    }
    return { proto: "ss", server: host, server_port: port, method, password, rawTag: tag || undefined };
  }

  let decoded: string;
  try {
    decoded = decodeBase64Text(body);
  } catch {
    throw new Error("invalid ss link: body is not decodable base64");
  }
  const m = decoded.match(/^(.*?):(.*?)@(?:\[([^\]]+)\]|([^:]+)):(\d+)\/?$/);
  if (!m) throw new Error("invalid ss link: decoded body has no method:password@host:port");
  const method = (m[1] ?? "").trim();
  const password = m[2] ?? "";
  const host = (m[3] ?? m[4] ?? "").trim();
  const port = Number(m[5]);
  if (method === "" || password === "" || host === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid ss link: bad decoded fields");
  }
  return { proto: "ss", server: host, server_port: port, method, password, rawTag: tag || undefined };
}
