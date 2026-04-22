import type Database from "better-sqlite3";
import { fetchPendingFor, getPeer, markDelivered } from "./db.js";
import { heartbeat, type SelfContext } from "./peer.js";

export interface ChannelEmitter {
  emit(params: {
    content: string;
    meta: Record<string, string>;
  }): Promise<void>;
}

export interface PollLoopHandle {
  stop(): void;
}

export interface PollOptions {
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export function startPollLoop(
  db: Database.Database,
  self: SelfContext,
  emitter: ChannelEmitter,
  opts: PollOptions = {},
): PollLoopHandle {
  const intervalMs = opts.intervalMs ?? 1000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      heartbeat(db, self.id);
      const pending = fetchPendingFor(db, self.id);
      for (const msg of pending) {
        const sender = getPeer(db, msg.from_id);
        const meta: Record<string, string> = {
          from_id: msg.from_id,
          sent_at: msg.created_at,
          message_id: msg.id,
        };
        if (sender?.summary) meta.from_summary = sender.summary;
        if (sender?.cwd) meta.from_cwd = sender.cwd;
        await emitter.emit({ content: msg.content, meta });
        markDelivered(db, msg.id, new Date().toISOString());
      }
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const interval = setInterval(() => void tick(), intervalMs);
  // Do not keep the process alive solely for the poll loop.
  interval.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}
