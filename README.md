<p align="center">
  <img src="./assets/logo.png" alt="claude-bus" width="280" />
</p>

# claude-bus

An MCP server that lets two or more Claude Code sessions on the same machine
send messages to each other, with a persistent SQLite log you can tail.

Built on Claude Code's `claude/channel` experimental capability: messages
arrive in the receiver's context as `<channel source="claude-bus" ...>` events,
so the receiving Claude reads them mid-session without polling.

## Status

v0.1 — **bus + persistent log**. Every message is stored in SQLite and
inspectable via CLI. No approval gate yet (planned for v0.2 via file-drop).

## Requirements

- Node 20+
- Claude Code 2.1.80 or newer (on 2.1.117 at time of writing)
- `claude-bus` is a custom channel, which is not on Anthropic's approved
  allowlist. During the channels research preview, start each session with
  the development flag so Claude Code registers the notification listener:

  ```bash
  claude --dangerously-load-development-channels server:claude-bus
  ```

  Do **not** combine with `--channels` — the bypass is per-entry and
  `--channels` entries require the approved allowlist. Channels require a
  claude.ai or setup-token OAuth (not a raw API key) and disable
  `AskUserQuestion` and plan mode while active.

## Install (local dev)

```bash
git clone <this repo> ~/claude-bus
cd ~/claude-bus
npm install
npm run build
npm link
```

Then add to a Claude Code session via `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "claude-bus": {
      "command": "claude-bus-mcp"
    }
  }
}
```

Or globally: `claude mcp add claude-bus -- claude-bus-mcp`.

Start each Claude Code session you want on the bus with:

```bash
claude --dangerously-load-development-channels server:claude-bus
```

## Tools exposed

| Tool | Purpose |
|---|---|
| `list_peers({ scope: "repo" \| "directory" \| "machine" })` | Find other sessions. `repo` is the default. |
| `send_message({ to_id, content })` | Deliver a message. Receiver sees it within ~1s as a `<channel>` event. |
| `set_summary({ summary })` | Label this session so peers see what you're doing in `list_peers`. |

## CLI

The same package installs a `claude-bus` CLI for visibility:

```bash
claude-bus peers                          # live peers on the machine
claude-bus log --follow                   # tail every message as it flows
claude-bus log --peer <id>                # filter to one peer
claude-bus log --since 2026-04-21T00:00Z  # messages since an ISO timestamp
claude-bus stats                          # counts + top senders
```

## Data layout

- Database: `~/.claude-bus/bus.db` (override with `CLAUDE_BUS_DB=/path/to.db`).
- Schema: two tables — `peers`, `messages` — with a `status` column sized for
  the upcoming approval gate (`pending → approved/rejected → delivered`).

## Roadmap

- **v0.2** — approval gate. Outbound messages wait as JSON files in
  `~/.claude-bus/pending/<ulid>.json`. Approve by `mv` to `approved/`, reject
  by deleting. A watcher picks up the state change and transitions the DB row.
- **v0.3** — localhost web dashboard. Live stream + approve/inject buttons.
  Introduces a small broker process at that point.

Out of scope: multi-machine transport, auth/encryption, message retention
policy, permission relay for tool-use dialogs.

## Why not claude-peers-mcp / let-them-talk / claude-tempo

- `claude-peers-mcp`: closest prior art, but ships with
  `--dangerously-skip-permissions` in its quickstart, no audit trail, no
  approval path, and hasn't seen commits in a month.
- `let-them-talk`: feature-complete (dashboard, kanban, 65 tools) but rapid
  version churn and task-evidence approval, not per-message gating.
- `claude-tempo`: needs a Temporal server. Overkill for localhost sessions.

`claude-bus` keeps the surface minimal and owns the parts that matter for
visibility and control: every message is in SQLite from day one, the CLI is in
the box, and the schema is sized so adding an approval gate is a handler
change, not a migration.

## Development

```bash
npm run dev:mcp     # run the MCP server against stdio (for debugging)
npm run dev:cli -- peers
npm test            # unit + integration tests (spawns two subprocess sessions)
npm run typecheck
```

## License

MIT
