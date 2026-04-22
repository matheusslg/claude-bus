import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const MCP_ENTRY = resolve(REPO_ROOT, "src/mcp.ts");

interface Harness {
  client: Client;
  transport: StdioClientTransport;
  inbox: Array<{ content: string; meta: Record<string, string> }>;
  close: () => Promise<void>;
}

async function spawnSession(dbPath: string, cwd: string): Promise<Harness> {
  const inbox: Harness["inbox"] = [];
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "tsx", MCP_ENTRY],
    cwd,
    env: {
      ...process.env,
      CLAUDE_BUS_DB: dbPath,
    } as Record<string, string>,
  });

  const client = new Client({ name: "claude-bus-test", version: "0.0.0" });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") {
      const params = n.params as
        | { content: string; meta?: Record<string, string> }
        | undefined;
      if (params) {
        inbox.push({ content: params.content, meta: params.meta ?? {} });
      }
    }
  };

  await client.connect(transport);
  return {
    client,
    transport,
    inbox,
    close: async () => {
      await client.close();
    },
  };
}

async function listPeers(
  h: Harness,
  scope: "machine" | "directory" | "repo" = "machine",
): Promise<Array<{ id: string; summary: string }>> {
  const res = await h.client.callTool({
    name: "list_peers",
    arguments: { scope },
  });
  const content = (res.content as Array<{ type: string; text: string }>)[0];
  const parsed = JSON.parse(content?.text ?? "{}") as {
    peers?: Array<{ id: string; summary: string }>;
  };
  return parsed.peers ?? [];
}

async function sendMessage(
  h: Harness,
  to_id: string,
  content: string,
): Promise<void> {
  await h.client.callTool({
    name: "send_message",
    arguments: { to_id, content },
  });
}

async function setSummary(h: Harness, summary: string): Promise<void> {
  await h.client.callTool({
    name: "set_summary",
    arguments: { summary },
  });
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

describe("integration: two sessions", () => {
  let tmp: string;
  let dbPath: string;
  let a: Harness | undefined;
  let b: Harness | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-bus-itest-"));
    dbPath = join(tmp, "bus.db");
  });

  afterEach(async () => {
    await a?.close();
    await b?.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("delivers a message from A to B via notifications/claude/channel", async () => {
    a = await spawnSession(dbPath, tmp);
    b = await spawnSession(dbPath, tmp);

    await setSummary(a, "session A");
    await setSummary(b, "session B");

    // A discovers B.
    const peersFromA = await waitFor(async () => {
      const peers = await listPeers(a!, "machine");
      return peers.length > 0 ? peers : undefined;
    });
    const bPeer = peersFromA.find((p) => p.summary === "session B");
    expect(bPeer).toBeDefined();

    await sendMessage(a, bPeer!.id, "hello from A");

    const delivered = await waitFor(() =>
      b!.inbox.find((m) => m.content === "hello from A"),
    );
    expect(delivered.content).toBe("hello from A");
    expect(delivered.meta.from_id).toBeDefined();
    expect(delivered.meta.from_id).toHaveLength(8);
    expect(delivered.meta.sent_at).toBeDefined();
    expect(delivered.meta.message_id).toBeDefined();
  }, 20_000);

  it("refuses to send to unknown peer", async () => {
    a = await spawnSession(dbPath, tmp);
    const res = await a.client.callTool({
      name: "send_message",
      arguments: { to_id: "nosuch01", content: "hi" },
    });
    expect(res.isError).toBe(true);
    const text = (
      (res.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
    );
    expect(text).toMatch(/no such peer|not alive/);
  }, 15_000);
});
