# opencode-pi-intercom

[![npm version](https://img.shields.io/npm/v/opencode-pi-intercom)](https://www.npmjs.com/package/opencode-pi-intercom)
[![npm downloads](https://img.shields.io/npm/dm/opencode-pi-intercom)](https://www.npmjs.com/package/opencode-pi-intercom)
[![License: MIT](https://img.shields.io/npm/l/opencode-pi-intercom)](./LICENSE)

OpenCode plugin that joins the [omp-intercom](https://github.com/ersintarhan/omp-intercom) / [pi-intercom](https://www.npmjs.com/package/pi-intercom) broker as a peer. Your OpenCode sessions appear in the same roster as omp and pi sessions, receive injected prompts from them, reply back, and expose an `intercom` tool to the OpenCode agent — agentic messaging and orchestration across all three agents on one machine.

```
omp session ◄──► broker (omp-intercom) ◄──► pi session
                        ▲
                        └────────── opencode (this plugin)
```

## Why

Models distributed through OpenCode (e.g. Meta's Muse Spark on OpenCode Zen) are only reachable from OpenCode clients. With this plugin an omp/pi orchestrator delegates work to OpenCode (`ask`), OpenCode runs it with its own model and tools, and the answer flows back over the same broker.

## Install (npm)

Package: [opencode-pi-intercom on npm](https://www.npmjs.com/package/opencode-pi-intercom)

```jsonc
// ~/.config/opencode/opencode.json (or opencode.jsonc, or .opencode/opencode.json)
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-pi-intercom"]
}
```

OpenCode bun-installs the package (and its `@opencode-ai/plugin` dependency) automatically at startup. Requires the official OpenCode CLI ≥ 1.18 (`bun add -g opencode-ai`). Then start opencode — on first instance init the plugin connects and logs:

```
[opencode-pi-intercom] connected to broker as "opencode" (session …)
```

The broker itself belongs to omp-intercom; the plugin auto-spawns it from the installed `omp-intercom` package when the socket is missing (`omp install npm:omp-intercom`). It never ships its own broker copy.

## Install (local checkout)

```bash
mkdir -p ~/.config/opencode/plugins
cp -R . ~/.config/opencode/plugins/opencode-pi-intercom
rm -rf ~/.config/opencode/plugins/opencode-pi-intercom/node_modules
cat > ~/.config/opencode/plugins/opencode-pi-intercom.ts <<'EOF'
export { IntercomPlugin } from "./opencode-pi-intercom/src/index.ts";
EOF
# ~/.config/opencode/opencode.json: { "plugin": ["./plugins/opencode-pi-intercom.ts"] }
```

## Configuration

`~/.config/opencode/intercom.json` (all optional):

```jsonc
{
  "enabled": true,
  "name": "opencode",            // roster name; MUST be unique per instance
  "agentDir": null,              // broker owner dir; default PI_CODING_AGENT_DIR or ~/.omp/agent
                                  // set "~/.pi/agent" to join a pi-intercom roster instead
  "sessionID": null,             // fixed target session for injections; default: active/latest
  "bridgeModel": null,           // "providerID/modelID" forced on injected prompts
                                  // e.g. "opencode/muse-spark-1.3"
  "autoReply": true,             // on session.idle, send the newest assistant text as the ask reply
                                  // (skips when the agent already replied via the intercom tool)
  "inboundTrigger": "always",    // always | replies | never (falls back to the shared intercom config)
  "askTimeoutMs": 600000,
  "stableId": null               // restart-stable intercom session id (mailbox redelivery)
}
```

Env overrides: `OPENCODE_INTERCOM_ENABLED`, `OPENCODE_INTERCOM_NAME`, `OPENCODE_INTERCOM_AGENT_DIR`, `OPENCODE_INTERCOM_SESSION_ID`, `OPENCODE_INTERCOM_MODEL`, `OPENCODE_INTERCOM_AUTO_REPLY`, `OPENCODE_INTERCOM_CONFIG`. Shared vars honored: `PI_CODING_AGENT_DIR`, `PI_INTERCOM_SCOPE_ID`, `PI_INTERCOM_ASK_TIMEOUT_MS`, `PI_INTERCOM_LIVENESS_*`.

## Agent usage

The OpenCode agent gets an `intercom` tool mirroring the omp/pi one:

```typescript
intercom({ action: "list" })
intercom({ action: "send", to: "hearth-mahjong-developer", message: "AuthService retry eklendi mi?" })
intercom({ action: "ask", to: "planner", message: "JWT mi session cookie mi?" })  // blocks until reply
intercom({ action: "reply", message: "Session cookies — browser-first." })
intercom({ action: "status" })
```

Inbound messages arrive as prompts prefixed with `[intercom] Message from <name>`; when they expect a reply the prompt includes the exact `reply` invocation. Replies to the agent's own outbound asks resolve the tool call directly — they are never re-injected as prompts. Without `@opencode-ai/plugin` resolvable the tool is absent but messaging still works (`autoReply` covers ask flows).

## Semantics

- **Receipts**: inbound messages are acknowledged `receiver_received` immediately, then `injected (opencode session …)` once the prompt is enqueued — the omp-side sender sees the full chain.
- **autoReply staleness guard**: the plugin snapshots the last assistant text before injecting an ask and only auto-replies with text produced *after* it — stale messages are never resent.
- **Ask race safety**: a reply that arrives before the ask's handler registers is buffered (bounded) and still resolves the ask.
- **Presence**: `idle` / `thinking` / `tool:<name>` from session status + tool execution events; the model label tracks the live session model (e.g. `opencode/muse-spark-1.3`).
- **Liveness**: 30s heartbeat probes detect half-open sockets and reconnect with backoff; registration re-claims the same intercom session id when `stableId` is configured.

## Testing

```bash
bun test   # 45 tests: unit (framing/protocol/paths/config/session bridge),
           # client vs fake broker, and full-loop integration against the
           # real omp-intercom broker in an isolated temp agent dir
```

Integration tests auto-skip when the real broker source is absent; point `INTERCOM_TEST_BROKER` at a broker.ts to force them. Manual peer for live checks:

```bash
PEER_NAME=dev-1 bun test/peer.ts wait          # stays registered, auto-acks asks
PEER_NAME=dev-1 bun test/peer.ts ask --to opencode --text "ping" --timeout-ms 600000
```

## Troubleshooting

- **`intercom tool disabled` in logs** — `@opencode-ai/plugin` did not resolve; for local installs add `~/.config/opencode/package.json` with `{ "dependencies": { "@opencode-ai/plugin": "^1.18.31" } }`.
- **Asks stall** — the target session may be busy with a long agent run: injected prompts queue behind it. Wait, or `POST /session/:id/abort`, or set `sessionID` to a dedicated session.
- **Ambiguous sends / duplicate names** — two instances registered with the same `name` make sends to that name fail closed. Give each instance a unique `name` (or `OPENCODE_INTERCOM_NAME`). Short-lived test peers should use unique `PEER_NAME`s too.
- **No plugin load in serve mode** — Open Design's embedded opencode build (`0.0.0--…` dev snapshots) skips config plugins in serve mode and is rejected by the Zen free tier; use the official CLI.
- **Muse Spark** — requires OpenCode-side Zen access (`opencode auth login`); free-tier models work from official clients ≥ 1.18.
- **Scope isolation** — peers only see each other when `PI_INTERCOM_SCOPE_ID` matches; leave unset for the shared default scope.

## Notes & limits

- Wire protocol is omp/pi-intercom v1 (4-byte BE length + JSON, ≤ 1 MiB frames); `protocol.ts` / `framing.ts` are ports of the upstream sources.
- Windows transport (named pipe / TCP) is untested; macOS/Linux paths only.

## License

MIT
