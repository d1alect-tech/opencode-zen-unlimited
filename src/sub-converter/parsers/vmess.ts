import type { NormalizedNode } from "../types.ts";
import { decodeBase64Text } from "../detect.ts";

interface VmessJson {
  add?: string;
  port?: string | number;
  id?: string;
  aid?: string | number;
  scy?: string;
  net?: string;
  tls?: string;
  sni?: string;
  ps?: string;
}

/** vmess://base64(json)#tag — legacy RoundTrip-style links. */
export function parseVmess(line: string): NormalizedNode {
  const body = line.replace(/^vmess:\/\//i, "").split("#")[0] ?? "";
  if (body === "") throw new Error("invalid vmess link: empty body");
  let json: VmessJson;
  try {
    json = JSON.parse(decodeBase64Text(body.trim())) as VmessJson;
  } catch {
    throw new Error("invalid vmess link: body is not base64 json");
  }
  const host = (json.add ?? "").trim();
  if (host === "") throw new Error("invalid vmess link: missing address");
  const port = Number(json.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid vmess port: ${String(json.port)}`);
  }
  const uuid = (json.id ?? "").trim();
  if (uuid === "") throw new Error("invalid vmess link: missing id");
  const tlsOn = (json.tls ?? "").toLowerCase() === "tls";
  return {
    proto: "vmess",
    server: host,
    server_port: port,
    uuid,
    security: json.scy && json.scy !== "" ? json.scy : "auto",
    alterId: json.aid !== undefined && json.aid !== "" ? Number(json.aid) : 0,
    network: json.net && json.net !== "" ? json.net : undefined,
    tls: tlsOn ? { enabled: true, server_name: json.sni && json.sni !== "" ? json.sni : host } : undefined,
    rawTag: json.ps && json.ps !== "" ? json.ps : undefined,
  };
}
