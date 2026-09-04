/** Shared types for the sub-converter pipeline (Goal 1). */

export type Proto = "vless" | "vmess" | "trojan" | "ss" | "hysteria2";

export interface RealityConfig {
  public_key: string;
  short_id: string;
}

export interface TransportConfig {
  type: string;
  path?: string;
  mode?: string;
}

export interface TlsConfig {
  enabled: boolean;
  server_name?: string;
  insecure?: boolean;
  alpn?: string[];
  /** uTLS fingerprint (clash `client-fingerprint`, vless `fp`). */
  fingerprint?: string;
  /** Reality handshake (clash `reality-opts`, vless `pbk`/`sid`). */
  reality?: RealityConfig;
}

/** Normalized node record: scheme, host, port, credential refs. */
export interface NormalizedNode {
  proto: Proto;
  server: string;
  server_port: number;
  uuid?: string;
  password?: string;
  method?: string;
  security?: string;
  alterId?: number;
  flow?: string;
  tls?: TlsConfig;
  network?: string;
  /** Non-TCP transport (clash `network`, vless `type`) with its opts. */
  transport?: TransportConfig;
  /** Packet encoding (clash `packet-encoding`, vless `packetEncoding`). */
  packetEncoding?: string;
  rawTag?: string;
}

export interface SingboxOutbound {
  type: string;
  tag: string;
  server?: string;
  server_port?: number;
  [key: string]: unknown;
}

export interface SingboxConfig {
  outbounds: SingboxOutbound[];
  route: { final: string; [key: string]: unknown };
}

/** Relay pool entry. Superset of the relay UPSTREAMS {host,port} contract. */
export interface RelayUpstream {
  tag: string;
  server: string;
  port: number;
  proto: Proto;
}

export interface ConvertOptions {
  includeProtos?: Proto[];
  excludeKeywords?: string[];
}

export interface ConvertResult {
  outbounds: SingboxOutbound[];
  relayUpstreams: RelayUpstream[];
  singboxConfig: SingboxConfig;
  dropped: number;
  errors: string[];
}

export interface TemplateInput {
  outbounds?: Array<Record<string, unknown>>;
  route?: Record<string, unknown>;
}
