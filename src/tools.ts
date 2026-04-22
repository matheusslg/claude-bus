import { ulid } from "ulid";
import { z } from "zod";
import type Database from "better-sqlite3";
import {
  deletePeer,
  getPeer,
  insertMessage,
  listPeersInScope,
  setPeerSummary,
} from "./db.js";
import { isPidAlive, type SelfContext } from "./peer.js";

export const listPeersSchema = {
  scope: z
    .enum(["machine", "directory", "repo"])
    .default("repo")
    .describe(
      "Filter peers by shared git repo, shared cwd, or whole machine.",
    ),
};

export const sendMessageSchema = {
  to_id: z
    .string()
    .length(8)
    .describe("Target peer id (8-char from list_peers)."),
  content: z
    .string()
    .min(1)
    .max(16_000)
    .describe("Message body. Rendered as <channel> content on the receiver."),
};

export const setSummarySchema = {
  summary: z
    .string()
    .max(500)
    .describe("A 1-2 sentence summary of what this session is working on."),
};

type JsonText = { content: [{ type: "text"; text: string }] };

function textOk(value: unknown): JsonText {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function makeTools(
  db: Database.Database,
  self: SelfContext,
): {
  listPeers: (input: { scope: "machine" | "directory" | "repo" }) => JsonText;
  sendMessage: (input: { to_id: string; content: string }) => JsonText;
  setSummary: (input: { summary: string }) => JsonText;
} {
  return {
    listPeers: ({ scope }) => {
      const rows = listPeersInScope(db, scope, self);
      // Prune peers whose PID is gone.
      const live = rows.filter((p) => {
        if (isPidAlive(p.pid)) return true;
        deletePeer(db, p.id);
        return false;
      });
      return textOk({
        self_id: self.id,
        scope,
        peers: live.map((p) => ({
          id: p.id,
          summary: p.summary,
          cwd: p.cwd,
          git_root: p.git_root,
          registered_at: p.registered_at,
          last_seen: p.last_seen,
        })),
      });
    },

    sendMessage: ({ to_id, content }) => {
      if (to_id === self.id) {
        throw new Error("refusing to send a message to self");
      }
      const target = getPeer(db, to_id);
      if (!target) {
        throw new Error(`no such peer: ${to_id}`);
      }
      if (!isPidAlive(target.pid)) {
        deletePeer(db, target.id);
        throw new Error(`peer ${to_id} is no longer alive`);
      }
      const id = ulid();
      const created_at = new Date().toISOString();
      insertMessage(db, {
        id,
        from_id: self.id,
        to_id,
        content,
        created_at,
      });
      return textOk({ ok: true, message_id: id, to_id, created_at });
    },

    setSummary: ({ summary }) => {
      setPeerSummary(db, self.id, summary);
      return textOk({ ok: true, summary });
    },
  };
}
