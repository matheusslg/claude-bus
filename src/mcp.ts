#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "./db.js";
import { startHub } from "./http.js";
import { deregisterSelf, registerSelf } from "./peer.js";
import { startPollLoop } from "./poll.js";
import { buildMcpServer, makeEmitter } from "./server.js";

interface HttpConfig {
  enabled: boolean;
  port: number;
  bindHost?: string;
}

// Transport selection. stdio stays the DEFAULT and unchanged; HTTP is strictly
// opt-in via `--http` (with `--port`) or CLAUDE_BUS_HTTP_PORT.
function resolveHttpConfig(argv: string[]): HttpConfig {
  const flag = argv.includes("--http") || !!process.env.CLAUDE_BUS_HTTP_PORT;
  const portFlagIdx = argv.indexOf("--port");
  const portFromFlag =
    portFlagIdx >= 0 ? Number(argv[portFlagIdx + 1]) : undefined;
  const portFromEnv = process.env.CLAUDE_BUS_HTTP_PORT
    ? Number(process.env.CLAUDE_BUS_HTTP_PORT)
    : undefined;
  const port = portFromFlag ?? portFromEnv ?? 9200;
  return {
    enabled: flag,
    port,
    bindHost: process.env.CLAUDE_BUS_HTTP_HOST,
  };
}

function errorLogger(tag: string): (err: unknown) => void {
  const errorLog =
    process.env.CLAUDE_BUS_ERROR_LOG ??
    join(homedir(), ".claude-bus", "mcp-errors.log");
  mkdirSync(dirname(errorLog), { recursive: true });
  return (err) => {
    const line = `${new Date().toISOString()} [${tag}] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
    try {
      appendFileSync(errorLog, line);
    } catch {
      // Best-effort; never crash on a log write failure.
    }
    process.stderr.write(line);
  };
}

async function runStdio(): Promise<void> {
  const db = openDb();
  const self = registerSelf(db);
  const mcp = buildMcpServer(db, self);

  const poll = startPollLoop(db, self, makeEmitter(mcp), {
    onError: errorLogger(self.id),
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

async function runHub(cfg: HttpConfig): Promise<void> {
  const db = openDb();
  const onError = errorLogger("hub");
  const hub = await startHub(db, {
    port: cfg.port,
    bindHost: cfg.bindHost,
    onError,
  });
  const addr = hub.server.address();
  const bound =
    addr && typeof addr === "object" ? `${addr.address}:${addr.port}` : addr;
  process.stderr.write(
    `[claude-bus] hub listening on http://${bound}/mcp (loopback only)\n`,
  );

  const shutdown = (): void => {
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const cfg = resolveHttpConfig(process.argv.slice(2));
  if (cfg.enabled) {
    await runHub(cfg);
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  process.stderr.write(`[claude-bus] fatal: ${String(err)}\n`);
  process.exit(1);
});
