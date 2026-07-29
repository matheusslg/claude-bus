import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import {
  deletePendingFor,
  fetchPendingFor,
  insertMessage,
  listPeersInScope,
  markDelivered,
  openDb,
  setPeerSummary,
  upsertPeer,
} from "../src/db.js";
import Database from "better-sqlite3";

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claude-bus-test-"));
  db = openDb(join(tmp, "bus.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function peer(
  id: string,
  overrides: Partial<{
    cwd: string;
    git_root: string | null;
    summary: string;
    host: string | null;
  }> = {},
) {
  const now = new Date().toISOString();
  return {
    id,
    pid: 12345,
    cwd: overrides.cwd ?? "/tmp/work",
    git_root: overrides.git_root ?? null,
    summary: overrides.summary ?? "",
    registered_at: now,
    last_seen: now,
    host: overrides.host ?? null,
  };
}

describe("db", () => {
  it("bootstraps schema and upserts peers", () => {
    upsertPeer(db, peer("aaaaaaaa"));
    upsertPeer(db, peer("aaaaaaaa", { summary: "updated" }));
    const rows = listPeersInScope(db, "machine", {
      id: "zzzzzzzz",
      cwd: "/x",
      git_root: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("updated");
  });

  it("filters peers by scope", () => {
    upsertPeer(db, peer("aaaaaaaa", { cwd: "/a", git_root: "/a" }));
    upsertPeer(db, peer("bbbbbbbb", { cwd: "/b", git_root: "/a" }));
    upsertPeer(db, peer("cccccccc", { cwd: "/c", git_root: "/c" }));

    const inRepo = listPeersInScope(db, "repo", {
      id: "zzzzzzzz",
      cwd: "/a",
      git_root: "/a",
    });
    expect(inRepo.map((p) => p.id).sort()).toEqual(["aaaaaaaa", "bbbbbbbb"]);

    const inDir = listPeersInScope(db, "directory", {
      id: "zzzzzzzz",
      cwd: "/a",
      git_root: "/a",
    });
    expect(inDir.map((p) => p.id)).toEqual(["aaaaaaaa"]);

    const inMachine = listPeersInScope(db, "machine", {
      id: "zzzzzzzz",
      cwd: "/z",
      git_root: null,
    });
    expect(inMachine).toHaveLength(3);
  });

  it("excludes self from all scopes", () => {
    upsertPeer(db, peer("selfself", { cwd: "/a", git_root: "/a" }));
    upsertPeer(db, peer("otherrrr", { cwd: "/a", git_root: "/a" }));
    const rows = listPeersInScope(db, "repo", {
      id: "selfself",
      cwd: "/a",
      git_root: "/a",
    });
    expect(rows.map((p) => p.id)).toEqual(["otherrrr"]);
  });

  it("inserts, fetches, and transitions messages", () => {
    const id = ulid();
    insertMessage(db, {
      id,
      from_id: "sender01",
      to_id: "target02",
      content: "hi",
      created_at: new Date().toISOString(),
    });

    const pending = fetchPendingFor(db, "target02");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");

    markDelivered(db, id, new Date().toISOString());
    expect(fetchPendingFor(db, "target02")).toHaveLength(0);
  });

  it("markDelivered is idempotent and only affects pending rows", () => {
    const id = ulid();
    const created = new Date().toISOString();
    insertMessage(db, {
      id,
      from_id: "s",
      to_id: "t",
      content: "x",
      created_at: created,
    });
    markDelivered(db, id, new Date().toISOString());
    const first = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
      | { delivered_at: string; status: string }
      | undefined;
    markDelivered(db, id, "2099-01-01T00:00:00Z"); // should not overwrite
    const second = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
      | { delivered_at: string; status: string }
      | undefined;
    expect(second?.delivered_at).toBe(first?.delivered_at);
    expect(second?.status).toBe("delivered");
  });

  it("deletePendingFor drops only pending rows for a target", () => {
    const a = ulid();
    const b = ulid();
    const c = ulid();
    const now = new Date().toISOString();
    insertMessage(db, { id: a, from_id: "s", to_id: "t", content: "a", created_at: now });
    insertMessage(db, { id: b, from_id: "s", to_id: "t", content: "b", created_at: now });
    insertMessage(db, { id: c, from_id: "s", to_id: "u", content: "c", created_at: now });
    markDelivered(db, a, now);

    deletePendingFor(db, "t");

    const remaining = db
      .prepare(`SELECT id FROM messages ORDER BY id`)
      .all() as { id: string }[];
    // a stays (already delivered), b is dropped (pending for t), c stays (different target)
    expect(remaining.map((r) => r.id).sort()).toEqual([a, c].sort());
  });

  it("stores and returns the host column", () => {
    upsertPeer(db, peer("aaaaaaaa", { host: "mac-mini" }));
    upsertPeer(db, peer("bbbbbbbb", { host: null }));
    const rows = listPeersInScope(db, "machine", {
      id: "zzzzzzzz",
      cwd: "/x",
      git_root: null,
    });
    expect(rows.find((p) => p.id === "aaaaaaaa")?.host).toBe("mac-mini");
    expect(rows.find((p) => p.id === "bbbbbbbb")?.host).toBeNull();
  });

  it("migrates a pre-host DB: adds column, keeps all rows", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "claude-bus-mig-"));
    const p = join(tmp2, "old.db");
    // Build a DB with the OLD schema (no host column) and seed a row.
    const old = new Database(p);
    old.exec(`
      CREATE TABLE peers (
        id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL,
        git_root TEXT, summary TEXT NOT NULL DEFAULT '',
        registered_at TEXT NOT NULL, last_seen TEXT NOT NULL
      );`);
    const now = new Date().toISOString();
    old
      .prepare(
        `INSERT INTO peers (id,pid,cwd,git_root,summary,registered_at,last_seen)
         VALUES ('legacy01',999,'/old',NULL,'legacy',?,?)`,
      )
      .run(now, now);
    old.close();

    // Reopen with the new code — migrate() must add the column, lose nothing.
    const migrated = openDb(p);
    const cols = (
      migrated.prepare(`PRAGMA table_info(peers)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("host");
    const row = migrated.prepare(`SELECT * FROM peers`).get() as {
      id: string;
      summary: string;
      host: string | null;
    };
    expect(row.id).toBe("legacy01");
    expect(row.summary).toBe("legacy");
    expect(row.host).toBeNull();
    // Re-running openDb is idempotent (no throw on second migrate).
    migrated.close();
    const again = openDb(p);
    expect(again.prepare(`SELECT COUNT(*) AS n FROM peers`).get()).toEqual({
      n: 1,
    });
    again.close();
    rmSync(tmp2, { recursive: true, force: true });
  });

  it("setPeerSummary updates only the target peer", () => {
    upsertPeer(db, peer("aaaaaaaa"));
    upsertPeer(db, peer("bbbbbbbb"));
    setPeerSummary(db, "aaaaaaaa", "working on X");
    const all = listPeersInScope(db, "machine", {
      id: "zzzzzzzz",
      cwd: "/x",
      git_root: null,
    });
    const a = all.find((p) => p.id === "aaaaaaaa");
    const b = all.find((p) => p.id === "bbbbbbbb");
    expect(a?.summary).toBe("working on X");
    expect(b?.summary).toBe("");
  });
});
