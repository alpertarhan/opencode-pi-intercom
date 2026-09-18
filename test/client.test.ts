import { describe, expect, test } from "bun:test";
import net from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { IntercomClient } from "../src/client.ts";
import { createMessageReader, writeMessage } from "../src/framing.ts";
import type { ClientMessage } from "../src/protocol.ts";
import { registration, waitFor } from "./helpers.ts";

interface FakeBroker {
  path: string;
  frames: ClientMessage[];
  sockets: net.Socket[];
  onFrame: ((frame: ClientMessage, socket: net.Socket) => void) | null;
  send: (socket: net.Socket, msg: unknown) => void;
  close: () => Promise<void>;
}

async function startFakeBroker(): Promise<FakeBroker> {
  const dir = mkdtempSync(join(tmpdir(), "oc-fake-broker-"));
  const path = join(dir, "broker.sock");
  const frames: ClientMessage[] = [];
  const sockets: net.Socket[] = [];
  const broker: FakeBroker = {
    path,
    frames,
    sockets,
    onFrame: null,
    send: (socket, msg) => writeMessage(socket, msg),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on(
      "data",
      createMessageReader((raw) => {
        frames.push(raw as ClientMessage);
        if (broker.onFrame) broker.onFrame(raw as ClientMessage, socket);
      }, () => {}),
    );
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return broker;
}

describe("IntercomClient against a fake broker", () => {
  test("connect registers and resolves on `registered`", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") {
        broker.send(socket, { type: "registered", sessionId: "srv-42", features: ["exact-send-v1"] });
      }
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    expect(client.id).toBe("srv-42");
    expect(client.isConnected()).toBe(true);
    expect(broker.frames.some((f) => f.type === "register")).toBe(true);
    client.unregister();
    await broker.close();
  }, 10_000);

  test("send resolves delivered on `delivered` and carries the payload", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
      if (frame.type === "send") {
        broker.send(socket, {
          type: "delivered",
          messageId: frame.message.id,
          delivery: "socket_delivered",
          retryable: false,
          outcomeKnown: true,
        });
      }
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    const result = await client.send("beta", "hello", {
      expectsReply: true,
      attachments: [{ type: "snippet", name: "a.ts", content: "x" }],
    });
    expect(result.delivered).toBe(true);
    expect(result.delivery).toBe("socket_delivered");
    const sendFrame = broker.frames.find((f) => f.type === "send");
    expect(sendFrame && sendFrame.type === "send" && sendFrame.to).toBe("beta");
    expect(sendFrame && sendFrame.type === "send" && sendFrame.message.content.text).toBe("hello");
    expect(sendFrame && sendFrame.type === "send" && sendFrame.message.expectsReply).toBe(true);
    expect(sendFrame && sendFrame.type === "send" && sendFrame.message.content.attachments).toEqual([
      { type: "snippet", name: "a.ts", content: "x" },
    ]);
    client.unregister();
    await broker.close();
  }, 10_000);

  test("send resolves failed with the broker reason on `delivery_failed`", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
      if (frame.type === "send") {
        broker.send(socket, {
          type: "delivery_failed",
          messageId: frame.message.id,
          reason: "Session not found",
          delivery: "failed",
          retryable: false,
          outcomeKnown: true,
        });
      }
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    const result = await client.send("ghost", "hi");
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("Session not found");
    client.unregister();
    await broker.close();
  }, 10_000);

  test("ask resolves when a reply with matching replyTo arrives", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
      if (frame.type === "send" && frame.message.expectsReply) {
        broker.send(socket, {
          type: "delivered",
          messageId: frame.message.id,
          delivery: "socket_delivered",
          retryable: false,
          outcomeKnown: true,
        });
        broker.send(socket, {
          type: "message",
          from: { id: "peer-9", cwd: "/tmp", model: "m", pid: 1, startedAt: 0, lastActivity: 0, name: "beta" },
          message: { id: "reply-1", timestamp: Date.now(), replyTo: frame.message.id, content: { text: "the answer" } },
        });
      }
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    const answer = await client.ask("beta", "question", 5_000);
    expect(answer.replyText).toBe("the answer");
    expect(answer.fromName).toBe("beta");
    client.unregister();
    await broker.close();
  }, 10_000);

  test("ask rejects on timeout and sends cancel_ask", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
      if (frame.type === "send") {
        broker.send(socket, {
          type: "delivered",
          messageId: frame.message.id,
          delivery: "socket_delivered",
          retryable: false,
          outcomeKnown: true,
        });
      }
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    await expect(client.ask("beta", "anyone?", 250)).rejects.toThrow("timed out");
    await waitFor(() => broker.frames.some((f) => f.type === "cancel_ask"), 2_000, "cancel_ask frame");
    client.unregister();
    await broker.close();
  }, 10_000);

  test("sendReceipt and presence write protocol frames", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    client.sendReceipt("m-1", "injected", "opencode session s");
    client.presence({ status: "tool:bash", model: "p/m" });
    await waitFor(() => broker.frames.some((f) => f.type === "presence"), 2_000, "presence frame");
    const receipt = broker.frames.find((f) => f.type === "message_receipt");
    expect(receipt && receipt.type === "message_receipt" ? receipt.receipt : null).toMatchObject({
      messageId: "m-1",
      status: "injected",
      detail: "opencode session s",
    });
    const presence = broker.frames.find((f) => f.type === "presence");
    expect(presence && presence.type === "presence" ? presence : null).toMatchObject({
      status: "tool:bash",
      model: "p/m",
    });
    client.unregister();
    await broker.close();
  }, 10_000);

  test("unregister writes the frame and closes the connection", async () => {
    const broker = await startFakeBroker();
    broker.onFrame = (frame, socket) => {
      if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
    };
    const client = new IntercomClient();
    await client.connect(broker.path, registration("alpha"));
    const closed = new Promise<void>((resolve) => broker.sockets[0].once("close", resolve));
    client.unregister();
    await closed;
    expect(broker.frames.some((f) => f.type === "unregister")).toBe(true);
    expect(client.isConnected()).toBe(false);
    await broker.close();
  }, 10_000);

  // Integration exception: the heartbeat is real-clock behavior (setInterval
  // probing a socket); fake timers cannot drive the network round-trip.
  test("liveness heartbeat probes with list and detects a dead connection", async () => {
    const previousInterval = process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
    process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = "40";
    try {
      const broker = await startFakeBroker();
      broker.onFrame = (frame, socket) => {
        if (frame.type === "register") broker.send(socket, { type: "registered", sessionId: "srv" });
        if (frame.type === "list") {
          broker.send(socket, { type: "sessions", requestId: frame.requestId, sessions: [] });
        }
      };
      const client = new IntercomClient();
      await client.connect(broker.path, registration("alpha"));
      await waitFor(() => broker.frames.filter((f) => f.type === "list").length >= 3, 5_000, "3 liveness probes");

      const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
      broker.sockets[0].destroy(); // broker-side death
      await disconnected;
      expect(client.isConnected()).toBe(false);
      await broker.close();
    } finally {
      if (previousInterval === undefined) delete process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS;
      else process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS = previousInterval;
    }
  }, 15_000);
});
