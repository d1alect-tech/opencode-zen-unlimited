import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createNodeFetchImpl,
  HEADERS_TIMEOUT_MS,
  resolveHeadersTimeoutMs,
  resolveStallTimeoutMs,
  STALL_TIMEOUT_MS,
  type NodeFetchImplOptions,
} from "@/gateway/transport";
import type {
  FetchImpl,
  UpstreamRequestInit,
} from "@/gateway/forward";

const SSE_DOC: string = "data: hello\n\ndata: [DONE]\n\n";

function startChunkedServer(
  onRequest: (
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      onRequest(res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${String(addr.port)}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const s = server as Server & { closeAllConnections?: () => void };
    s.closeAllConnections?.();
    server.close(() => resolve());
  });
}

const baseInit: UpstreamRequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

const fastOptions: NodeFetchImplOptions = { stallTimeoutMs: 10_000 };

afterEach(() => {
  expect(STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
});

describe("headers budget", () => {
  test("default leaves room for failover under the client 30s cap", () => {
    expect(HEADERS_TIMEOUT_MS).toBe(15_000);
  });

  test("silent upstream rejects within the headers budget", async () => {
    const { server, url } = await startChunkedServer((_res) => {
      // Accept the connection, never write head: headers watchdog fires.
    });
    try {
      const fetchImpl: FetchImpl = createNodeFetchImpl({
        headersTimeoutMs: 300,
      });
      await expect(fetchImpl(url, baseInit)).rejects.toThrow(/headers/i);
    } finally {
      await closeServer(server);
    }
  });

  test("headers env override parses like the stall one", () => {
    expect(resolveHeadersTimeoutMs({})).toBe(HEADERS_TIMEOUT_MS);
    expect(resolveHeadersTimeoutMs({ HEADERS_TIMEOUT_MS: "8000" })).toBe(
      8_000,
    );
    expect(resolveHeadersTimeoutMs({ HEADERS_TIMEOUT_MS: "nope" })).toBe(
      HEADERS_TIMEOUT_MS,
    );
  });
});

describe("stall budget", () => {
  test("default fits long generations with reasoning pauses", () => {
    expect(STALL_TIMEOUT_MS).toBe(120_000);
  });

  test("env override tunes the budget without code change", () => {
    expect(resolveStallTimeoutMs({})).toBe(STALL_TIMEOUT_MS);
    expect(resolveStallTimeoutMs({ STALL_TIMEOUT_MS: "45000" })).toBe(45_000);
  });

  test("garbage env falls back to the default", () => {
    expect(resolveStallTimeoutMs({ STALL_TIMEOUT_MS: "" })).toBe(
      STALL_TIMEOUT_MS,
    );
    expect(resolveStallTimeoutMs({ STALL_TIMEOUT_MS: "soon" })).toBe(
      STALL_TIMEOUT_MS,
    );
    expect(resolveStallTimeoutMs({ STALL_TIMEOUT_MS: "-5" })).toBe(
      STALL_TIMEOUT_MS,
    );
  });
});

describe("createNodeFetchImpl", () => {
  test("streams chunked SSE bodies to completion", async () => {
    const { server, url } = await startChunkedServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: hello\n\n");
      setTimeout(() => {
        res.end("data: [DONE]\n\n");
      }, 50);
    });
    try {
      const fetchImpl: FetchImpl = createNodeFetchImpl(fastOptions);
      const res: Response = await fetchImpl(url, baseInit);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      expect(await res.text()).toBe(SSE_DOC);
    } finally {
      await closeServer(server);
    }
  });

  test("passes error statuses with bodies 1:1", async () => {
    const { server, url } = await startChunkedServer((res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad" }));
    });
    try {
      const fetchImpl: FetchImpl = createNodeFetchImpl(fastOptions);
      const res: Response = await fetchImpl(url, baseInit);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad" });
    } finally {
      await closeServer(server);
    }
  });

  test("stalled bodies reject within the stall budget", async () => {
    const { server, url } = await startChunkedServer((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: partial\n\n");
      // Never ends: the pump watchdog must fire, not hang forever.
    });
    try {
      const fetchImpl: FetchImpl = createNodeFetchImpl({
        stallTimeoutMs: 300,
      });
      const res: Response = await fetchImpl(url, baseInit);
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow(/stall/i);
    } finally {
      await closeServer(server);
    }
  });
});
