import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message, Peer, PeerScope } from "./types.js";

export const DEFAULT_DB_PATH =
  process.env.CLAUDE_BUS_DB && process.env.CLAUDE_BUS_DB.length > 0
    ? process.env.CLAUDE_BUS_DB
    : join(homedir(), ".claude-bus", "bus.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peers (
  id            TEXT PRIMARY KEY,
  pid           INTEGER NOT NULL,
  cwd           TEXT NOT NULL,
  git_root      TEXT,
  summary       TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL,
  to_id        TEXT NOT NULL,
  content      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_to_status ON messages(to_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_created   ON messages(created_at);
`;

export function openDb(path: string = DEFAULT_DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 2000");
  db.exec(SCHEMA);
  return db;
}

export function upsertPeer(db: Database.Database, peer: Peer): void {
  db.prepare(
    `INSERT INTO peers (id, pid, cwd, git_root, summary, registered_at, last_seen)
     VALUES (@id, @pid, @cwd, @git_root, @summary, @registered_at, @last_seen)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       cwd = excluded.cwd,
       git_root = excluded.git_root,
       summary = excluded.summary,
       last_seen = excluded.last_seen`,
  ).run(peer);
}

export function touchPeer(db: Database.Database, id: string, now: string): void {
  db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`).run(now, id);
}

export function setPeerSummary(
  db: Database.Database,
  id: string,
  summary: string,
): void {
  db.prepare(`UPDATE peers SET summary = ? WHERE id = ?`).run(summary, id);
}

export function deletePeer(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM peers WHERE id = ?`).run(id);
}

export function listPeersInScope(
  db: Database.Database,
  scope: PeerScope,
  self: { id: string; cwd: string; git_root: string | null },
): Peer[] {
  if (scope === "machine") {
    return db
      .prepare(`SELECT * FROM peers WHERE id != ? ORDER BY registered_at DESC`)
      .all(self.id) as Peer[];
  }
  if (scope === "directory") {
    return db
      .prepare(
        `SELECT * FROM peers WHERE id != ? AND cwd = ? ORDER BY registered_at DESC`,
      )
      .all(self.id, self.cwd) as Peer[];
  }
  // "repo": prefer git_root equality; if we don't have a git_root, fall back to cwd.
  if (self.git_root) {
    return db
      .prepare(
        `SELECT * FROM peers WHERE id != ? AND git_root = ? ORDER BY registered_at DESC`,
      )
      .all(self.id, self.git_root) as Peer[];
  }
  return db
    .prepare(
      `SELECT * FROM peers WHERE id != ? AND git_root IS NULL AND cwd = ? ORDER BY registered_at DESC`,
    )
    .all(self.id, self.cwd) as Peer[];
}

export function getPeer(db: Database.Database, id: string): Peer | undefined {
  return db.prepare(`SELECT * FROM peers WHERE id = ?`).get(id) as
    | Peer
    | undefined;
}

export function insertMessage(
  db: Database.Database,
  msg: Omit<Message, "status" | "delivered_at"> & {
    status?: Message["status"];
  },
): void {
  db.prepare(
    `INSERT INTO messages (id, from_id, to_id, content, status, created_at, delivered_at)
     VALUES (@id, @from_id, @to_id, @content, @status, @created_at, NULL)`,
  ).run({ ...msg, status: msg.status ?? "pending" });
}

export function fetchPendingFor(
  db: Database.Database,
  to_id: string,
): Message[] {
  return db
    .prepare(
      `SELECT * FROM messages WHERE to_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    )
    .all(to_id) as Message[];
}

export function markDelivered(
  db: Database.Database,
  id: string,
  now: string,
): void {
  db.prepare(
    `UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'`,
  ).run(now, id);
}

export function deletePendingFor(db: Database.Database, to_id: string): void {
  db.prepare(
    `DELETE FROM messages WHERE to_id = ? AND status = 'pending'`,
  ).run(to_id);
}
