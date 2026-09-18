// Manual intercom peer for integration testing against a live broker.
//
//   bun test/peer.ts list
//   bun test/peer.ts send --to opencode --text "hi"
//   bun test/peer.ts ask  --to opencode --text "ping" [--timeout-ms 60000]
//   bun test/peer.ts wait [--seconds 120]   # stay registered, print inbound

import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "../src/framing.ts";
import { asBrokerMessage } from "../src/protocol.ts";

const socketPath = process.env.INTERCOM_SOCKET ?? `${process.env.HOME}/.omp/agent/intercom/broker.sock`;
const argv = process.argv.slice(2);
const action = argv[0] ?? "list";
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = process.env.PEER_NAME ?? "tester";

const socket = net.connect(socketPath);
socket.on("error", (error) => {
  console.error("socket error:", error.message);
  process.exit(1);
});
socket.on("data", createMessageReader((raw) => handle(raw), (error) => {
  console.error("frame error:", error.message);
  socket.destroy();
  process.exit(1);
}));

let askedId: string | null = null;
const timeoutMs = Number(flag("timeout-ms") ?? 30_000);

writeMessage(socket, {
  type: "register",
  session: {
    cwd: process.cwd(),
    model: "test-peer",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    name,
    status: "idle",
  },
});

function exit(code: number): void {
  socket.destroy();
  process.exit(code);
}

function handle(raw: unknown): void {
  const msg = asBrokerMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case "registered": {
      console.error(`registered as ${name} (${msg.sessionId})`);
      if (action === "list") {
        writeMessage(socket, { type: "list", requestId: "r1" });
      } else if (action === "send" || action === "ask") {
        askedId = randomUUID();
        writeMessage(socket, {
          type: "send",
          to: flag("to") ?? "opencode",
          message: {
            id: askedId,
            timestamp: Date.now(),
            senderSequence: 1,
            ...(action === "ask" ? { expectsReply: true } : {}),
            content: { text: flag("text") ?? "hello from test peer" },
          },
        });
        if (action === "ask") {
          setTimeout(() => {
            console.error("ask timed out");
            exit(2);
          }, timeoutMs).unref?.();
        }
      } else if (action === "wait") {
        const secs = Number(flag("seconds") ?? 120);
        setTimeout(() => exit(0), secs * 1000).unref?.();
      } else {
        console.error(`unknown action: ${action}`);
        exit(1);
      }
      break;
    }
    case "sessions":
      if (msg.requestId === "r1") {
        console.log(JSON.stringify(msg.sessions, null, 2));
        exit(0);
      }
      break;
    case "delivered":
      if (msg.messageId === askedId) {
        console.log(JSON.stringify({ delivered: true, delivery: msg.delivery }));
        if (action === "send") exit(0);
      }
      break;
    case "delivery_failed":
      if (msg.messageId === askedId) {
        console.log(JSON.stringify({ delivered: false, reason: msg.reason }));
        exit(3);
      }
      break;
    case "message": {
      const from = msg.from.name ?? msg.from.id;
      console.log(
        JSON.stringify(
          {
            from,
            expectsReply: msg.message.expectsReply === true,
            replyTo: msg.message.replyTo ?? null,
            text: msg.message.content.text,
          },
          null,
          2,
        ),
      );
      if (action === "ask" && msg.message.replyTo === askedId) exit(0);
      if (action === "wait" && msg.message.expectsReply) {
        writeMessage(socket, {
          type: "send",
          to: from,
          message: {
            id: randomUUID(),
            timestamp: Date.now(),
            senderSequence: 2,
            replyTo: msg.message.id,
            content: { text: "ack from test peer" },
          },
        });
      }
      break;
    }
    case "message_receipt":
      console.error(`receipt ${msg.receipt.messageId}: ${msg.receipt.status}${msg.receipt.detail ? ` (${msg.receipt.detail})` : ""}`);
      break;
    case "error":
      console.error("broker error:", msg.error);
      exit(4);
      break;
    default:
      break;
  }
}
