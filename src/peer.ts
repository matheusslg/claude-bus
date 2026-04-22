import { execSync } from "node:child_process";
import type Database from "better-sqlite3";
import type { Peer } from "./types.js";
import { deletePeer, deletePendingFor, touchPeer, upsertPeer } from "./db.js";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generatePeerId(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return out;
}

export function resolveGitRoot(cwd: string): string | null {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface SelfContext {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
}

export function registerSelf(db: Database.Database): SelfContext {
  const now = new Date().toISOString();
  const cwd = process.cwd();
  const self: Peer = {
    id: generatePeerId(),
    pid: process.pid,
    cwd,
    git_root: resolveGitRoot(cwd),
    summary: "",
    registered_at: now,
    last_seen: now,
  };
  upsertPeer(db, self);
  return {
    id: self.id,
    pid: self.pid,
    cwd: self.cwd,
    git_root: self.git_root,
  };
}

export function heartbeat(db: Database.Database, id: string): void {
  touchPeer(db, id, new Date().toISOString());
}

export function deregisterSelf(db: Database.Database, id: string): void {
  // Drop any pending inbound that we'll never deliver.
  deletePendingFor(db, id);
  deletePeer(db, id);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
