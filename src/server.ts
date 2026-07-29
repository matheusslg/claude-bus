import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import type { SelfContext } from "./peer.js";
import type { ChannelEmitter } from "./poll.js";
import {
  listPeersSchema,
  makeTools,
  sendMessageSchema,
  setSummarySchema,
} from "./tools.js";

export const SERVER_NAME = "claude-bus";
export const SERVER_VERSION = "0.1.0";
export const INSTRUCTIONS = `
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

// Builds a fully-wired McpServer for one session. Both the stdio entrypoint and
// each HTTP hub session use this so the two transports expose an identical tool
// surface against the same database.
export function buildMcpServer(
  db: Database.Database,
  self: SelfContext,
): McpServer {
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
        'Deliver a message to another claude-bus peer. The receiver gets it as a <channel source="claude-bus"> event within ~1s.',
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

  return mcp;
}

// The poll loop delivers pending messages by pushing a claude/channel
// notification down whichever transport this server is connected to.
export function makeEmitter(mcp: McpServer): ChannelEmitter {
  return {
    async emit({ content, meta }) {
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: { content, meta },
      });
    },
  };
}
