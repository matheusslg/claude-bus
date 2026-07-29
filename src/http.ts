import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type Database from "better-sqlite3";
import { deregisterSelf, registerSelf } from "./peer.js";
import { startPollLoop } from "./poll.js";
import { buildMcpServer, makeEmitter } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

// The hub binds loopback ONLY. Cross-machine reach is an SSH port-forward, so
// the bus inherits SSH's auth instead of exposing an unauthenticated socket to
// the network. Refuse anything non-loopback rather than silently widening it.
export function assertLoopback(bindHost: string): void {
  if (!LOOPBACK.has(bindHost)) {
    throw new Error(
      `refusing to bind claude-bus hub to non-loopback address "${bindHost}". ` +
        `The hub must bind 127.0.0.1; reach it from other machines via an SSH ` +
        `port-forward (ssh -N -L <port>:127.0.0.1:<port> <host>).`,
    );
  }
}

export interface HubHandle {
  server: Server;
  close: () => Promise<void>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
}

function firstHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startHub(
  db: Database.Database,
  opts: { port: number; bindHost?: string; onError?: (err: unknown) => void },
): Promise<HubHandle> {
  const bindHost = opts.bindHost ?? "127.0.0.1";
  assertLoopback(bindHost);

  const sessions = new Map<string, Session>();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      opts.onError?.(err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const sid = firstHeader(req, "mcp-session-id");

    // Existing session: GET (SSE stream), DELETE (teardown), or a follow-up POST.
    if (sid && sessions.has(sid)) {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await sessions.get(sid)!.transport.handleRequest(req, res, body);
      return;
    }

    // New session must arrive as an `initialize` POST with no session id.
    if (req.method !== "POST") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: "no valid session; expected initialize POST" }),
      );
      return;
    }

    const body = await readBody(req);
    if (sid || !isInitializeRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid or missing mcp session" }));
      return;
    }

    // A remote peer announces its own machine via X-Claude-Bus-Host (the
    // operator sets it in the remote's MCP `headers` config). Without it we
    // fall back to registerSelf's default (this hub's os.hostname()).
    const declaredHost = firstHeader(req, "x-claude-bus-host");
    const declaredCwd = firstHeader(req, "x-claude-bus-cwd");
    // pid/cwd/git_root here describe the hub, not the remote peer; host is the
    // one field a remote can correct. ponytail: liveness for HTTP peers rides
    // the transport's onclose below, not pid-scanning — good enough until a peer
    // dies without a clean close, at which point the hub restart prunes it.
    const self = registerSelf(db, {
      host: declaredHost,
      cwd: declaredCwd,
      git_root: null,
    });

    const mcp = buildMcpServer(db, self);
    // Poll loop delivers this peer's pending messages over its own SSE stream.
    // ponytail: at-most-once. If the client's SSE stream is momentarily absent
    // (mid-reconnect on an SSH-tunnel blip) the SDK drops the notification and
    // the row is still marked delivered — the message is lost. Not hit on a
    // steady connection (first tick is +1s, clients open the stream in ms).
    // Upgrade path if it bites: an SDK EventStore + Last-Event-ID replay.
    const poll = startPollLoop(db, self, makeEmitter(mcp), {
      onError: opts.onError,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport });
      },
    });

    let cleaned = false;
    transport.onclose = () => {
      if (cleaned) return;
      cleaned = true;
      poll.stop();
      if (transport.sessionId) sessions.delete(transport.sessionId);
      deregisterSelf(db, self.id);
    };

    // Connect the server to the transport BEFORE handing it the initialize
    // request, so the transport has a message handler when it replies.
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return new Promise<HubHandle>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, bindHost, () => {
      httpServer.removeListener("error", reject);
      resolve({
        server: httpServer,
        close: async () => {
          // Close each session's transport; its onclose stops the poll loop and
          // deregisters the peer.
          await Promise.all(
            [...sessions.values()].map((s) => s.transport.close()),
          );
          await new Promise<void>((res) => httpServer.close(() => res()));
        },
      });
    });
  });
}
