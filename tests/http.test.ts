import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { startHub, assertLoopback, type HubHandle } from "../src/http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = resolve(HERE, "..", "src/mcp.ts");

interface Peer {
  id: string;
  summary: string;
  host: string | null;
}

interface Session {
  client: Client;
  inbox: Array<{ content: string; meta: Record<string, string> }>;
  close: () => Promise<void>;
}

function attachInbox(client: Client): Session["inbox"] {
  const inbox: Session["inbox"] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") {
      const params = n.params as
        | { content: string; meta?: Record<string, string> }
        | undefined;
      if (params) inbox.push({ content: params.content, meta: params.meta ?? {} });
    }
  };
  return inbox;
}

async function connectHttp(port: number, host?: string): Promise<Session> {
  const client = new Client({ name: "claude-bus-http-test", version: "0.0.0" });
  const inbox = attachInbox(client);
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    host
      ? { requestInit: { headers: { "X-Claude-Bus-Host": host } } }
      : undefined,
  );
  await client.connect(transport);
  return { client, inbox, close: () => client.close() };
}

async function connectStdio(dbPath: string, cwd: string): Promise<Session> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "tsx", MCP_ENTRY],
    cwd,
    env: { ...process.env, CLAUDE_BUS_DB: dbPath } as Record<string, string>,
  });
  const client = new Client({ name: "claude-bus-stdio-test", version: "0.0.0" });
  const inbox = attachInbox(client);
  await client.connect(transport);
  return { client, inbox, close: () => client.close() };
}

async function listPeers(s: Session): Promise<Peer[]> {
  const res = await s.client.callTool({
    name: "list_peers",
    arguments: { scope: "machine" },
  });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text;
  return (JSON.parse(text ?? "{}") as { peers?: Peer[] }).peers ?? [];
}

async function send(s: Session, to_id: string, content: string): Promise<void> {
  const res = await s.client.callTool({
    name: "send_message",
    arguments: { to_id, content },
  });
  if (res.isError) {
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text;
    throw new Error(`send failed: ${text}`);
  }
}

// The id of the peer with the given summary, as seen from this session.
async function peerIdBySummary(s: Session, summary: string): Promise<string> {
  const hit = await waitFor(async () => {
    const ps = await listPeers(s);
    return ps.find((p) => p.summary === summary);
  });
  return hit.id;
}

async function setSummary(s: Session, summary: string): Promise<void> {
  await s.client.callTool({ name: "set_summary", arguments: { summary } });
}

async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

describe("http hub", () => {
  let tmp: string;
  let dbPath: string;
  let db: Database.Database;
  let hub: HubHandle;
  let port: number;
  const open: Session[] = [];

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "claude-bus-http-"));
    dbPath = join(tmp, "bus.db");
    db = openDb(dbPath);
    hub = await startHub(db, { port: 0 });
    const addr = hub.server.address();
    port = addr && typeof addr === "object" ? addr.port : 0;
  });

  afterEach(async () => {
    for (const s of open.splice(0)) await s.close().catch(() => {});
    await hub.close();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("assertLoopback refuses non-loopback binds", () => {
    expect(() => assertLoopback("0.0.0.0")).toThrow(/non-loopback/);
    expect(() => assertLoopback("192.168.1.5")).toThrow(/non-loopback/);
    expect(() => assertLoopback("127.0.0.1")).not.toThrow();
    expect(() => assertLoopback("::1")).not.toThrow();
    expect(() => assertLoopback("localhost")).not.toThrow();
  });

  it("registers a peer, delivers a message between two HTTP sessions", async () => {
    const a = await connectHttp(port, "box-a");
    const b = await connectHttp(port, "box-b");
    open.push(a, b);
    await setSummary(a, "session A");
    await setSummary(b, "session B");

    const peers = await waitFor(async () => {
      const ps = await listPeers(a);
      return ps.length > 0 ? ps : undefined;
    });
    const bPeer = peers.find((p) => p.summary === "session B");
    expect(bPeer).toBeDefined();
    // host announced via X-Claude-Bus-Host reaches the peer row.
    expect(bPeer!.host).toBe("box-b");

    await send(a, bPeer!.id, "hello over http");
    const got = await waitFor(() =>
      b.inbox.find((m) => m.content === "hello over http"),
    );
    expect(got.meta.from_id).toHaveLength(8);
  }, 20_000);

  it("a stdio peer and an HTTP peer see each other and message both ways", async () => {
    // Same DB, two transports, one host — the actual feature.
    const stdio = await connectStdio(dbPath, tmp);
    const http = await connectHttp(port, "remote-box");
    open.push(stdio, http);
    await setSummary(stdio, "the stdio one");
    await setSummary(http, "the http one");

    // Each session finds the OTHER by its summary. To message the http peer,
    // the stdio session uses the id *it* sees; and vice versa.
    const httpId = await peerIdBySummary(stdio, "the http one");
    const stdioId = await peerIdBySummary(http, "the stdio one");

    // The stdio session sees the HTTP peer tagged with its announced host.
    const httpPeerRow = (await listPeers(stdio)).find((p) => p.id === httpId);
    expect(httpPeerRow?.host).toBe("remote-box");

    // stdio -> http
    await send(stdio, httpId, "http, this is stdio");
    expect(
      await waitFor(() =>
        http.inbox.find((m) => m.content === "http, this is stdio"),
      ),
    ).toBeDefined();

    // http -> stdio
    await send(http, stdioId, "stdio, this is http");
    expect(
      await waitFor(() =>
        stdio.inbox.find((m) => m.content === "stdio, this is http"),
      ),
    ).toBeDefined();
  }, 30_000);
});
