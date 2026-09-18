// Integration against the REAL omp-intercom broker, isolated in a temp agent
// dir. Real process spawn + sockets: waits poll conditions rather than fake
// timers (deterministic time control cannot drive an external process).

import { describe, expect, test } from "bun:test";
import { IntercomClient } from "../src/client.ts";
import { getBrokerSocketPath } from "../src/paths.ts";
import type { ChildProcess } from "child_process";
import {
  cleanupAgentDir,
  hasRealBroker,
  registration,
  startRealBroker,
  tmpAgentDir,
  waitFor,
} from "./helpers.ts";

const describeReal = hasRealBroker() ? describe : describe.skip;

describeReal("IntercomClient against the real omp-intercom broker", () => {
  test("roster, send, ask round-trip, receipts, unknown target", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const alpha = new IntercomClient();
    const beta = new IntercomClient();
    try {
      broker = await startRealBroker(agentDir);
      const socketPath = getBrokerSocketPath(agentDir);

      await alpha.connect(socketPath, registration("alpha"));
      await beta.connect(socketPath, registration("beta"));

      // Roster: alpha sees beta (and itself).
      const roster = await alpha.list();
      expect(roster.map((s) => s.name)).toContain("beta");
      expect(roster.map((s) => s.name)).toContain("alpha");

      // Receipts flow back to the sender as the receiver acknowledges.
      const receipts: string[] = [];
      alpha.on("receipt", (_from, receipt) => receipts.push(receipt.status));

      // beta acts as a replying agent: acknowledges with receipts and echoes
      // expectsReply messages (the hub plugin does the same on receipt).
      beta.on("message", (from, message) => {
        beta.sendReceipt(message.id, "receiver_received");
        if (message.expectsReply) {
          void beta.reply(from.name ?? from.id, message.id, `echo:${message.content.text}`).then(() => {
            beta.sendReceipt(message.id, "injected");
          });
        }
      });

      // Ask round-trip with replyTo threading.
      const answer = await alpha.ask("beta", "ping", 8_000);
      expect(answer.replyText).toBe("echo:ping");
      expect(answer.fromName).toBe("beta");

      // Receiver-side receipt chain (receiver_received → injected).
      await waitFor(
        () => receipts.includes("receiver_received") && receipts.includes("injected"),
        5_000,
        "receipt chain at sender",
      );

      // Plain fire-and-forget send.
      const sent = await alpha.send("beta", "fire and forget");
      expect(sent.delivered).toBe(true);

      // Unknown target must not report delivery.
      const ghost = await alpha.send("no-such-session-anywhere", "hi");
      expect(ghost.delivered).toBe(false);
    } finally {
      alpha.unregister();
      beta.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 25_000);

  test("mailbox redelivery to a reconnected named peer", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const sender = new IntercomClient();
    let receiver = new IntercomClient();
    try {
      broker = await startRealBroker(agentDir);
      const socketPath = getBrokerSocketPath(agentDir);

      await sender.connect(socketPath, registration("sender"));
      await receiver.connect(socketPath, registration("mailbox"));
      // Ensure the broker has the peer in its roster before disconnecting.
      await sender.list();

      const inbox: string[] = [];
      receiver.on("message", (_from, message) => inbox.push(message.content.text));
      receiver.unregister();

      // Wait until the broker has actually dropped the peer — otherwise the
      // send could race the unregister and be delivered to the dying socket.
      await waitFor(
        async () => !(await sender.list()).some((s) => s.name === "mailbox"),
        5_000,
        "mailbox peer to leave the roster",
      );

      // Send while the named peer is gone → queued mailbox mail.
      const queued = await sender.send("mailbox", "offline note");
      expect(queued.delivery === "queued" || queued.delivered).toBe(true);

      // Same name+cwd reconnects → mail arrives. The listener must sit on the
      // NEW client; the old one is gone and keeps its own (dead) emitter.
      receiver = new IntercomClient();
      const delivered = new Promise<void>((resolve) => {
        receiver.on("message", (_from, message) => {
          inbox.push(message.content.text);
          resolve();
        });
      });
      await receiver.connect(socketPath, registration("mailbox"));
      await delivered;
      expect(inbox).toContain("offline note");
    } finally {
      sender.unregister();
      receiver.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 25_000);
});
