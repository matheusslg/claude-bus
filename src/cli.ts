#!/usr/bin/env node
import { openDb } from "./db.js";
import { isPidAlive } from "./peer.js";
import type { Message, Peer } from "./types.js";

type Args = {
  command: string | undefined;
  flags: Map<string, string | boolean>;
};

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (!command) {
      command = token;
    }
  }
  return { command, flags };
}

function fmtTime(iso: string): string {
  return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function cmdPeers(): void {
  const db = openDb();
  const rows = db
    .prepare(`SELECT * FROM peers ORDER BY registered_at DESC`)
    .all() as Peer[];
  if (rows.length === 0) {
    console.log("(no peers registered)");
    return;
  }
  console.log(
    "ID        PID     ALIVE  CWD                                     SUMMARY",
  );
  for (const p of rows) {
    const alive = isPidAlive(p.pid) ? "yes" : "NO ";
    const cwd = p.cwd.length > 38 ? "…" + p.cwd.slice(-37) : p.cwd.padEnd(38);
    const summary = p.summary || "(no summary)";
    console.log(`${p.id}  ${String(p.pid).padEnd(6)}  ${alive}    ${cwd}  ${summary}`);
  }
}

function cmdLog(flags: Args["flags"]): void {
  const db = openDb();
  const follow = flags.get("follow") === true;
  const peer = typeof flags.get("peer") === "string" ? (flags.get("peer") as string) : undefined;
  const since =
    typeof flags.get("since") === "string" ? (flags.get("since") as string) : undefined;

  let lastSeen = since ?? "1970-01-01T00:00:00Z";

  const render = (): void => {
    const where: string[] = ["created_at > ?"];
    const params: unknown[] = [lastSeen];
    if (peer) {
      where.push("(from_id = ? OR to_id = ?)");
      params.push(peer, peer);
    }
    const rows = db
      .prepare(
        `SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY created_at ASC`,
      )
      .all(...params) as Message[];
    for (const m of rows) {
      const status = m.status.padEnd(9);
      console.log(
        `${fmtTime(m.created_at)}  ${status}  ${shortId(m.from_id)} -> ${shortId(m.to_id)}  [${m.id}]  ${m.content.replace(/\n/g, " ⏎ ")}`,
      );
      if (m.created_at > lastSeen) lastSeen = m.created_at;
    }
  };

  render();
  if (!follow) return;

  const interval = setInterval(render, 500);
  process.on("SIGINT", () => {
    clearInterval(interval);
    process.exit(0);
  });
}

function cmdStats(): void {
  const db = openDb();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
  const pending = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'`).get() as { n: number }).n;
  const delivered = (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'delivered'`).get() as { n: number }).n;
  const peers = (db.prepare(`SELECT COUNT(*) AS n FROM peers`).get() as { n: number }).n;
  console.log(`peers:     ${peers}`);
  console.log(`messages:  ${total}  (pending=${pending}, delivered=${delivered})`);

  const topSenders = db
    .prepare(
      `SELECT from_id, COUNT(*) AS n FROM messages GROUP BY from_id ORDER BY n DESC LIMIT 5`,
    )
    .all() as { from_id: string; n: number }[];
  if (topSenders.length) {
    console.log("\ntop senders:");
    for (const s of topSenders) console.log(`  ${s.from_id}  ${s.n}`);
  }
}

function cmdHelp(): void {
  console.log(`claude-bus — inspect the message bus

Usage:
  claude-bus peers                          List registered peers.
  claude-bus log [--follow] [--peer <id>] [--since <iso>]
                                            Print messages; --follow to tail.
  claude-bus stats                          Show counts.
`);
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "peers":
      cmdPeers();
      break;
    case "log":
      cmdLog(flags);
      break;
    case "stats":
      cmdStats();
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      console.error(`unknown command: ${command}`);
      cmdHelp();
      process.exit(2);
  }
}

main();
