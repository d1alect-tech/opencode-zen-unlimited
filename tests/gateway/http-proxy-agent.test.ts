/**
 * `HttpProxyAgent` behavior tests.
 *
 * Note on method: Bun's `node:http`/`node:https` client stack ignores
 * custom `agent` objects (requests bypass `agent.createSocket`), so these
 * tests drive `agent.connect()` directly with a stub request — the exact
 * seam `agent-base` routes every proxied request through — against real
 * local proxy/origin servers over loopback TCP. That covers everything this
 * file owns: dialing the proxy, absolute-URI rewriting, `Proxy-Authorization`,
 * CONNECT framing, and non-200 surfacing. `dispatcher.ts` covers scheme
 * routing and caching; `transport.ts` is untouched by design.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import * as tls from "node:tls";
import * as net from "node:net";
import { HttpProxyAgent } from "@/gateway/http-proxy-agent";

interface ObservedRequest {
  readonly requestLine: string;
  readonly headers: Record<string, string>;
}

interface TestServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop() as TestServer;
    await server.close();
  }
});

function parseHead(head: string): ObservedRequest {
  const lines = head.split("\r\n");
  const requestLine: string = lines[0] ?? "";
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line
      .slice(idx + 1)
      .trim();
  }
  return { requestLine, headers };
}

/** Track every accepted socket so `close()` never hangs on open tunnels. */
function trackClients(server: net.Server): () => void {
  const clients = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    clients.add(socket);
    socket.on("close", () => {
      clients.delete(socket);
    });
  });
  return () => {
    for (const socket of clients) socket.destroy();
  };
}

function closeServer(
  server: net.Server | http.Server,
  destroyClients: () => void,
): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      destroyClients();
      const httpServer = server as http.Server & {
        closeAllConnections?: () => void;
      };
      httpServer.closeAllConnections?.();
      server.close(() => resolve());
    });
}

async function listenOn(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as { port: number }).port;
}

/** Origin HTTP server that always answers `origin-ok`. */
async function startOrigin(): Promise<TestServer> {
  const server = http.createServer(
    (_req: http.IncomingMessage, res: http.ServerResponse) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("origin-ok");
    },
  );
  const port = await listenOn(server);
  const tracked = trackCloseFor(closeServer(server, () => undefined), port);
  return tracked;
}

function trackCloseFor(
  close: () => Promise<void>,
  port: number,
): TestServer {
  const server: TestServer = { port, close };
  servers.push(server);
  return server;
}

/**
 * Dumb absolute-URI forwarding proxy for plain-http targets. Records every
 * request head, forwards raw bytes to the absolute-URI target, pipes back.
 */
async function startForwardProxy(): Promise<
  TestServer & { observed: ObservedRequest[] }
> {
  const observed: ObservedRequest[] = [];
  const server = net.createServer((client: net.Socket) => {
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk]);
      const text = pending.toString("latin1");
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      const parsed = parseHead(text.slice(0, end));
      observed.push(parsed);
      const target = parsed.requestLine.split(" ")[1] ?? "";
      const url = new URL(target);
      const upstream = net.connect(
        Number(url.port === "" ? "80" : url.port),
        url.hostname,
        () => {
          upstream.write(pending);
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      upstream.on("error", () => {
        client.destroy();
      });
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
  const destroyClients = trackClients(server);
  const port = await listenOn(server);
  const tracked = trackCloseFor(closeServer(server, destroyClients), port);
  return { ...tracked, observed };
}

/**
 * CONNECT-observing proxy for https targets. Replies `status` to every
 * CONNECT and records the raw head. On 200 the tunnel stays open (no TLS
 * server behind it): the agent hands back a `TLSSocket`, which the test
 * destroys — the CONNECT bytes are fully observable without a handshake.
 */
async function startConnectProxy(status: number): Promise<
  TestServer & { heads: string[] }
> {
  const heads: string[] = [];
  const server = net.createServer((client: net.Socket) => {
    let pending = "";
    const onData = (chunk: Buffer): void => {
      pending += chunk.toString("latin1");
      const end = pending.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.off("data", onData);
      heads.push(pending.slice(0, end));
      client.write(`HTTP/1.1 ${String(status)} X-Test\r\n\r\n`);
      if (status !== 200) client.end();
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  });
  const destroyClients = trackClients(server);
  const port = await listenOn(server);
  const tracked = trackCloseFor(closeServer(server, destroyClients), port);
  return { ...tracked, heads };
}

/** Stub request: the only `ClientRequest` surface `connect()` touches. */
function stubReq(path: string): {
  req: http.ClientRequest;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const req = {
    path,
    setHeader: (name: string, value: string): void => {
      headers[name.toLowerCase()] = value;
    },
  } as unknown as http.ClientRequest;
  return { req, headers };
}

/**
 * Send one raw HTTP request over an already-connected socket. Carries the
 * headers `connect()` staged on the stub request — the real client stack
 * would flush those alongside the rewritten request line.
 */
function socketHttpGet(
  socket: net.Socket,
  target: string,
  host: string,
  headers: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
    });
    socket.once("error", (err: Error) => reject(err));
    socket.once("close", () => resolve(pending));
    const extra = Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join("");
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`,
    );
  });
}

describe("HttpProxyAgent constructor", () => {
  test("non-http scheme rejected", () => {
    expect(() => new HttpProxyAgent("vless://user@example.com:443")).toThrow(
      /proxy URL/,
    );
  });

  test("invalid URL rejected", () => {
    expect(() => new HttpProxyAgent("not-a-url")).toThrow();
  });

  test("URL without auth accepted", () => {
    expect(
      new HttpProxyAgent("http://127.0.0.1:8080"),
    ).toBeInstanceOf(HttpProxyAgent);
  });
});

describe("HttpProxyAgent plain-http target", () => {
  test("dials the proxy and rewrites to absolute URI", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    const agent = new HttpProxyAgent(`http://127.0.0.1:${String(proxy.port)}`);
    try {
      const { req } = stubReq("/hello?x=1");
      const connected = await agent.connect(req, {
        host: "127.0.0.1",
        port: origin.port,
        secureEndpoint: false,
      });
      expect(connected).toBeInstanceOf(net.Socket);
      if (!(connected instanceof net.Socket)) {
        throw new Error("expected a net.Socket from connect()");
      }
      const socket: net.Socket = connected;
      try {
        expect(socket.remotePort).toBe(proxy.port);
        expect(req.path).toBe(
          `http://127.0.0.1:${String(origin.port)}/hello?x=1`,
        );
        const raw = await socketHttpGet(socket, req.path, "127.0.0.1", {});
        expect(raw).toMatch(/200/);
        expect(raw).toContain("origin-ok");
      } finally {
        socket.destroy();
      }
    } finally {
      agent.destroy();
    }
    expect(proxy.observed.length).toBe(1);
    expect(proxy.observed[0]?.requestLine).toBe(
      `GET http://127.0.0.1:${String(origin.port)}/hello?x=1 HTTP/1.1`,
    );
  });

  test("proxy userinfo becomes Proxy-Authorization, never in request line", async () => {
    const origin = await startOrigin();
    const proxy = await startForwardProxy();
    const agent = new HttpProxyAgent(
      `http://user:pass@127.0.0.1:${String(proxy.port)}`,
    );
    try {
      const { req, headers } = stubReq("/");
      const connected = await agent.connect(req, {
        host: "127.0.0.1",
        port: origin.port,
        secureEndpoint: false,
      });
      expect(connected).toBeInstanceOf(net.Socket);
      if (!(connected instanceof net.Socket)) {
        throw new Error("expected a net.Socket from connect()");
      }
      const socket: net.Socket = connected;
      try {
        expect(headers["proxy-authorization"]).toBe(
          `Basic ${Buffer.from("user:pass").toString("base64")}`,
        );
        expect(req.path).not.toContain("user:pass");
        const raw = await socketHttpGet(socket, req.path, "127.0.0.1", headers);
        expect(raw).toContain("origin-ok");
      } finally {
        socket.destroy();
      }
    } finally {
      agent.destroy();
    }
    expect(proxy.observed[0]?.headers["proxy-authorization"]).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  test("refused proxy rejects (never hangs)", async () => {
    const agent = new HttpProxyAgent("http://127.0.0.1:1");
    try {
      const { req } = stubReq("/unreachable");
      await expect(
        agent.connect(req, {
          host: "127.0.0.1",
          port: 9,
          secureEndpoint: false,
        }),
      ).rejects.toThrow();
    } finally {
      agent.destroy();
    }
  });
});

describe("HttpProxyAgent https target (CONNECT)", () => {
  test("sends CONNECT with host:port plus auth, returns a TLS socket", async () => {
    const proxy = await startConnectProxy(200);
    const agent = new HttpProxyAgent(
      `http://user:pass@127.0.0.1:${String(proxy.port)}`,
    );
    try {
      const { req } = stubReq("/");
      const socket = await agent.connect(req, {
        host: "127.0.0.1",
        port: 9,
        secureEndpoint: true,
      });
      try {
        expect(socket).toBeInstanceOf(tls.TLSSocket);
      } finally {
        socket.destroy();
      }
    } finally {
      agent.destroy();
    }
    expect(proxy.heads.length).toBe(1);
    const head: string = proxy.heads[0] ?? "";
    expect(head.split("\r\n")[0]).toBe("CONNECT 127.0.0.1:9 HTTP/1.1");
    expect(parseHead(head).headers["proxy-authorization"]).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  test("non-200 CONNECT surfaces the proxy status", async () => {
    const proxy = await startConnectProxy(403);
    const agent = new HttpProxyAgent(`http://127.0.0.1:${String(proxy.port)}`);
    try {
      const { req } = stubReq("/");
      await expect(
        agent.connect(req, {
          host: "127.0.0.1",
          port: 9,
          secureEndpoint: true,
        }),
      ).rejects.toThrow(/403/);
    } finally {
      agent.destroy();
    }
  });
});
