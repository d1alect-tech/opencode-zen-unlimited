/**
 * HTTP(S) proxy agent for purchased-proxy egress (`http://` / `https://`
 * entries in `EGRESS_UPSTREAMS`).
 *
 * Why a hand-rolled agent: the repo already ships `agent-base` (pinned exact
 * by `socks-proxy-agent`) and `node-fetch`, and `node-fetch` accepts any
 * `http.Agent` through the `FetchImpl.dispatcher` seam — so an
 * `agent-base`-derived agent plugs into `transport.ts` untouched, exactly
 * like `SocksProxyAgent` does. No new dependency.
 *
 * Protocol:
 * - Plain-http target: plain TCP (or TLS when the *proxy* URL is `https://`)
 *   to the proxy, request line rewritten to absolute URI form, credentials
 *   from the proxy userinfo sent as `Proxy-Authorization` (never in the URL).
 * - Https target: `CONNECT host:port` through the tunnel, then a TLS
 *   handshake with the *target* as SNI. Upstream certificates verify as
 *   usual (`rejectUnauthorized` stays on); the proxy only sees ciphertext.
 *
 * - `keepAlive: false`: fresh TCP+TLS per request, same convention as the
 *   SOCKS agents in `dispatcher.ts` (pool nodes flap; pooled sockets stall).
 * - No timers of our own: dial/CONNECT/TLS failures reject, and the caller
 *   (rotation's abort/timeout) owns the budget — a silent proxy surfaces as
 *   a caller timeout that benches the egress.
 */

import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";
import { Agent, type AgentConnectOpts } from "agent-base";

export interface HttpProxyAgentOptions extends http.AgentOptions {
  readonly keepAlive?: boolean;
}

/** Default proxy port when the proxy URL carries none. */
function defaultProxyPort(proxyScheme: string): number {
  return proxyScheme === "https:" ? 443 : 80;
}

/** Proxy userinfo (`user:pass@`) as a `Proxy-Authorization` value. */
function proxyAuthHeader(proxy: URL): string | undefined {
  if (proxy.username === "" && proxy.password === "") return undefined;
  let userinfo: string;
  try {
    userinfo = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  } catch {
    throw new Error("HttpProxyAgent: proxy userinfo is not valid URL encoding");
  }
  return `Basic ${Buffer.from(userinfo).toString("base64")}`;
}

/** Dial TCP, or TLS when the proxy itself is `https://`. */
function dialProxy(proxy: URL, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    let socket: net.Socket;
    if (proxy.protocol === "https:") {
      socket = tls.connect(
        { host: proxy.hostname, port, servername: proxy.hostname },
        () => {
          socket.off("error", onError);
          resolve(socket);
        },
      );
    } else {
      socket = net.connect({ host: proxy.hostname, port }, () => {
        socket.off("error", onError);
        resolve(socket);
      });
    }
    socket.once("error", onError);
  });
}

/** Read one HTTP response head (`\r\n\r\n`-terminated) off a tunnel socket. */
function readResponseHead(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString("latin1");
      if (pending.indexOf("\r\n\r\n") !== -1) {
        cleanup();
        resolve(pending);
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("HttpProxyAgent: proxy closed the tunnel early"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export class HttpProxyAgent extends Agent {
  /** Parsed proxy URL (userinfo intact: auth passes through untouched). */
  readonly proxy: URL;
  private readonly authHeader: string | undefined;

  constructor(proxyUrl: string, options: HttpProxyAgentOptions = {}) {
    super({ keepAlive: false, ...options });
    let proxy: URL;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      throw new Error(`HttpProxyAgent: invalid proxy URL, got: ${proxyUrl}`);
    }
    const scheme: string = proxy.protocol.toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") {
      throw new Error(
        `HttpProxyAgent: http/https proxy URL required, got: ${proxyUrl}`,
      );
    }
    this.proxy = proxy;
    this.authHeader = proxyAuthHeader(proxy);
  }

  async connect(
    req: http.ClientRequest,
    opts: AgentConnectOpts,
  ): Promise<Duplex> {
    const secureEndpoint: boolean = opts.secureEndpoint === true;
    const hostOpt: unknown = opts.host;
    if (typeof hostOpt !== "string" || hostOpt === "") {
      throw new Error("HttpProxyAgent: connect() requires opts.host");
    }
    const targetHost: string = hostOpt;
    const rawPort: unknown = opts.port;
    const targetPort: number =
      typeof rawPort === "number" && rawPort !== 0
        ? rawPort
        : secureEndpoint
          ? 443
          : 80;
    const proxyPort: number =
      this.proxy.port === ""
        ? defaultProxyPort(this.proxy.protocol)
        : Number(this.proxy.port);

    const socket: net.Socket = await dialProxy(this.proxy, proxyPort);

    if (!secureEndpoint) {
      const path: string = req.path ?? "/";
      if (!path.startsWith("http://") && !path.startsWith("https://")) {
        const origin = `http://${targetHost}:${String(targetPort)}`;
        req.path = path.startsWith("/")
          ? `${origin}${path}`
          : `${origin}/${path}`;
      }
      if (this.authHeader !== undefined) {
        req.setHeader("proxy-authorization", this.authHeader);
      }
      return socket;
    }

    const lines: string[] = [
      `CONNECT ${targetHost}:${String(targetPort)} HTTP/1.1`,
      `Host: ${targetHost}:${String(targetPort)}`,
    ];
    if (this.authHeader !== undefined) {
      lines.push(`Proxy-Authorization: ${this.authHeader}`);
    }
    lines.push("Connection: close", "", "");
    socket.write(lines.join("\r\n"));

    let head: string;
    try {
      head = await readResponseHead(socket);
    } catch (err) {
      socket.destroy();
      throw err;
    }
    const statusLine: string = head.split("\r\n")[0] ?? "";
    const status: number = Number(statusLine.split(" ")[1] ?? "");
    if (status !== 200) {
      socket.destroy();
      throw new Error(
        `HttpProxyAgent: CONNECT ${targetHost}:${String(targetPort)} rejected with status ${statusLine}`,
      );
    }
    const servername: unknown = (opts as { servername?: unknown }).servername;
    // SNI forbids IP literals (ERR_INVALID_ARG_VALUE): only send a
    // server name for DNS targets; IP targets handshake without SNI.
    const sni: string | undefined =
      typeof servername === "string"
        ? servername
        : net.isIP(targetHost) !== 0
          ? undefined
          : targetHost;
    return tls.connect({ socket, servername: sni });
  }
}
