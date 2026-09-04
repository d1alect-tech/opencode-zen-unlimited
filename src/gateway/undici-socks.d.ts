/**
 * Minimal ambient types for the real undici package files.
 *
 * The Bun runtime shadows the bare `undici` specifier with a builtin
 * subset (missing `Socks5ProxyAgent`, divergent `Dispatcher`/`Response`
 * types), so the gateway imports runtime values from the real package
 * files directly. These declarations describe only the surface the
 * gateway uses and stay clear of both the real undici types and the
 * DOM `RequestInit.dispatcher` pin (see `UpstreamRequestInit`).
 */
declare module "undici/index.js" {
  export interface UndiciFetchInit {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal | null;
    readonly dispatcher?: { close(): Promise<void> };
  }
  export function fetch(url: string, init?: UndiciFetchInit): Promise<Response>;
}
declare module "undici/lib/dispatcher/proxy-agent.js" {
  export default class ProxyAgent {
    constructor(
      options:
        | { uri: string; headersTimeout?: number; bodyTimeout?: number }
        | string,
    );
    close(): Promise<void>;
  }
}
declare module "undici/lib/dispatcher/socks5-proxy-agent.js" {
  export default class Socks5ProxyAgent {
    constructor(
      proxyUrl: string | URL,
      options?: { headersTimeout?: number; bodyTimeout?: number },
    );
    close(): Promise<void>;
  }
}
