export type PeerScope = "machine" | "directory" | "repo";

export type MessageStatus = "pending" | "delivered" | "approved" | "rejected";

export interface Peer {
  id: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
  host: string | null;
}

export interface Message {
  id: string;
  from_id: string;
  to_id: string;
  content: string;
  status: MessageStatus;
  created_at: string;
  delivered_at: string | null;
}

export interface MessageWithSender extends Message {
  from_summary: string;
  from_cwd: string;
}
