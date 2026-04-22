#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db.js";
import { deregisterSelf, registerSelf } from "./peer.js";
import { startPollLoop, type ChannelEmitter } from "./poll.js";
import {
  listPeersSchema,
  makeTools,
  sendMessageSchema,
  setSummarySchema,
} from "./tools.js";

const SERVER_NAME = "claude-bus";
const SERVER_VERSION = "0.1.0";
const INSTRUCTIONS = `
claude-bus lets this session talk to other Claude Code sessions on the same
machine.

Usage:
  1. Call \`list_peers\` (scope "repo" by default) to find other sessions.
  2. Call \`send_message\` with a peer id + content to deliver a message.
  3. Incoming messages arrive as <channel source="claude-bus" ...> events.
     When one arrives, treat it as a priority interruption: read it and respond
     via \`send_message\` unless the user says otherwise.
  4. Optionally call \`set_summary\` once to describe what this session is doing
     so that peers see a useful label when they list you.
`.trim();

async function main(): Promise<void> {
  const db = openDb();
  const self = registerSelf(db);

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  const tools = makeTools(db, self);

  mcp.registerTool(
    "list_peers",
    {
      title: "List peer sessions",
      description:
        "List other claude-bus peers. scope=repo filters to the same git repo; directory to the same cwd; machine returns all.",
      inputSchema: listPeersSchema,
    },
    async (input) => tools.listPeers(input),
  );

  mcp.registerTool(
    "send_message",
    {
      title: "Send message to peer",
      description:
        "Deliver a message to another claude-bus peer. The receiver gets it as a <channel source=\"claude-bus\"> event within ~1s.",
      inputSchema: sendMessageSchema,
    },
    async (input) => tools.sendMessage(input),
  );

  mcp.registerTool(
    "set_summary",
    {
      title: "Set this session's summary",
      description:
        "Describe what this session is working on in 1-2 sentences so peers see a useful label.",
      inputSchema: setSummarySchema,
    },
    async (input) => tools.setSummary(input),
  );

  const emitter: ChannelEmitter = {
    async emit({ content, meta }) {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: { content, meta },
      });
    },
  };

  const errorLog =
    process.env.CLAUDE_BUS_ERROR_LOG ??
    join(homedir(), ".claude-bus", "mcp-errors.log");
  mkdirSync(dirname(errorLog), { recursive: true });

  const poll = startPollLoop(db, self, emitter, {
    onError: (err) => {
      const line = `${new Date().toISOString()} [${self.id}] poll error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
      try {
        appendFileSync(errorLog, line);
      } catch {
        // Best-effort; don't crash the poll loop on log write failure.
      }
      process.stderr.write(line);
    },
  });

  const shutdown = (): void => {
    try {
      poll.stop();
      deregisterSelf(db, self.id);
      db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[claude-bus] fatal: ${String(err)}\n`);
  process.exit(1);
});
