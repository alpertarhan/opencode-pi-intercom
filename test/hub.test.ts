// Full plugin loop (startIntercom) against the real broker with a fake
// OpenCode SDK: inbound ask → prompt injection → simulated agent run →
// auto-reply → asker resolution. No opencode process required.

import { describe, expect, test } from "bun:test";
import { startIntercom } from "../src/index.ts";
import type { StartedIntercom } from "../src/index.ts";
import { IntercomClient } from "../src/client.ts";
import type { SdkClient } from "../src/session.ts";
import type { IntercomPluginConfig } from "../src/config.ts";
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

interface FakeSdk {
  sdk: SdkClient;
  prompts: Array<{ path: { id: string }; body: Record<string, unknown> }>;
  assistantText: string;
}

/** The fake agent: `prompt` records the injection and finishes synchronously. */
function makeFakeSdk(onRun?: () => void): FakeSdk {
  const prompts: FakeSdk["prompts"] = [];
  const state: FakeSdk = {
    prompts,
    assistantText: "OLD",
    sdk: {
      session: {
        list: async () => ({ data: [{ id: "ses_live", time: { updated: 5 } }] }),
        create: async () => {
          throw new Error("should not create a session when one exists");
        },
        prompt: async (args: unknown) => {
          prompts.push(args as FakeSdk["prompts"][number]);
          onRun?.();
        },
        messages: async () => ({
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: state.assistantText }] }],
        }),
      },
      config: { providers: async () => ({ data: { default: { build: "fake/model" } } }) },
    },
  };
  return state;
}

function makeCfg(agentDir: string, overrides: Partial<IntercomPluginConfig> = {}): IntercomPluginConfig {
  return {
    enabled: true,
    name: "oc-hub",
    agentDir,
    sessionID: null,
    bridgeModel: null,
    autoReply: true,
    inboundTrigger: "always",
    askTimeoutMs: 8_000,
    stableId: null,
    ...overrides,
  };
}

async function waitHubVisible(peer: IntercomClient): Promise<void> {
  await waitFor(
    async () => (await peer.list()).some((s) => s.name === "oc-hub"),
    5_000,
    "hub registration in roster",
  );
}

describeReal("startIntercom hub (real broker + fake SDK)", () => {
  test("inbound ask → injection → simulated run → auto-reply round-trip", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const peer = new IntercomClient();
    let started: StartedIntercom | null = null;
    try {
      broker = await startRealBroker(agentDir);

      const fake = makeFakeSdk(() => {
        // Agent finishes: new answer text, then OpenCode would emit idle.
        fake.assistantText = "ANSWER-42";
        void started?.hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_live" } } });
      });
      const hubLogs: string[] = [];
      started = startIntercom({
        cfg: makeCfg(agentDir),
        sdk: fake.sdk,
        cwd: "/tmp/hub-cwd",
        log: (...args: unknown[]) => hubLogs.push(args.map(String).join(" ")),
      });

      await peer.connect(getBrokerSocketPath(agentDir), registration("peer"));
      await waitHubVisible(peer);
      // The connect loop must COMPLETE — an exception after registration
      // would silently churn reconnects (regression: missing declaration).
      await waitFor(() => hubLogs.some((line) => line.includes('connected to broker as "oc-hub"')), 5_000, "connect-loop completion log");

      const receipts: string[] = [];
      peer.on("receipt", (_from, receipt) => receipts.push(receipt.status));

      const answer = await peer.ask("oc-hub", "what is the answer?", 8_000);
      expect(answer.replyText).toBe("ANSWER-42");

      // Injection carried the intercom header and the reply hint.
      expect(fake.prompts).toHaveLength(1);
      expect(fake.prompts[0].path.id).toBe("ses_live");
      const text = (fake.prompts[0].body.parts as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain("[intercom] Message from peer");
      expect(text).toContain("expects a reply");
      expect(text).toContain("what is the answer?");

      // Receipt chain reached the asker.
      await waitFor(
        () => receipts.includes("receiver_received") && receipts.includes("injected"),
        5_000,
        "receipt chain at peer",
      );
    } finally {
      started?.stop();
      peer.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 25_000);

  test("autoReply never resends stale text (preInject guard)", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const peer = new IntercomClient();
    let started: StartedIntercom | null = null;
    try {
      broker = await startRealBroker(agentDir);

      // The "agent" finishes but produces no new text — must NOT auto-reply.
      const fake = makeFakeSdk(() => {
        void started?.hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_live" } } });
      });
      started = startIntercom({ cfg: makeCfg(agentDir), sdk: fake.sdk, cwd: "/tmp/hub-cwd", log: () => {} });

      await peer.connect(getBrokerSocketPath(agentDir), registration("peer"));
      await waitHubVisible(peer);

      await expect(peer.ask("oc-hub", "silent treatment", 1_500)).rejects.toThrow("timed out");
      expect(fake.prompts).toHaveLength(1); // injection did happen
    } finally {
      started?.stop();
      peer.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 20_000);

  test("inboundTrigger=never injects as context only (noReply)", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const peer = new IntercomClient();
    let started: StartedIntercom | null = null;
    try {
      broker = await startRealBroker(agentDir);
      const fake = makeFakeSdk();
      started = startIntercom({
        cfg: makeCfg(agentDir, { inboundTrigger: "never", autoReply: false }),
        sdk: fake.sdk,
        cwd: "/tmp/hub-cwd",
        log: () => {},
      });

      await peer.connect(getBrokerSocketPath(agentDir), registration("peer"));
      await waitHubVisible(peer);

      const sent = await peer.send("oc-hub", "context only");
      expect(sent.delivered).toBe(true);
      await waitFor(() => fake.prompts.length === 1, 5_000, "noReply injection");
      expect(fake.prompts[0].body.noReply).toBe(true);
    } finally {
      started?.stop();
      peer.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 20_000);

  test("agent tool: list/status/send against the live roster", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const peer = new IntercomClient();
    const peerInbox: string[] = [];
    let started: StartedIntercom | null = null;
    try {
      broker = await startRealBroker(agentDir);
      const fake = makeFakeSdk();
      started = startIntercom({
        cfg: makeCfg(agentDir, { autoReply: false }),
        sdk: fake.sdk,
        cwd: "/tmp/hub-cwd",
        log: () => {},
      });

      await peer.connect(getBrokerSocketPath(agentDir), registration("peer"));
      peer.on("message", (_from, message) => peerInbox.push(message.content.text));
      await waitHubVisible(peer);

      const status = await started.hub.handleTool({ action: "status" });
      expect(status).toContain("name: oc-hub");
      expect(status).toContain("connected: true");

      const list = await started.hub.handleTool({ action: "list" });
      expect(list).toContain("peer");
      expect(list).not.toContain("oc-hub ("); // own entry filtered

      const sendResult = await started.hub.handleTool({ action: "send", to: "peer", message: "tool hello" });
      expect(sendResult).toContain("Message sent to peer");
      await waitFor(() => peerInbox.includes("tool hello"), 5_000, "peer inbox");

      const cwdResult = await started.hub.handleTool({ action: "send", message: "no target" });
      expect(cwdResult).toContain("Error");
    } finally {
      started?.stop();
      peer.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 25_000);

  test("outbound ask reply resolves the tool call without re-injecting as a prompt", async () => {
    const agentDir = tmpAgentDir();
    let broker: ChildProcess | null = null;
    const peer = new IntercomClient();
    let started: StartedIntercom | null = null;
    try {
      broker = await startRealBroker(agentDir);
      const fake = makeFakeSdk();
      started = startIntercom({ cfg: makeCfg(agentDir, { autoReply: false }), sdk: fake.sdk, cwd: "/tmp/hub-cwd", log: () => {} });

      await peer.connect(getBrokerSocketPath(agentDir), registration("peer"));
      peer.on("message", (from, message) => {
        if (message.expectsReply) {
          void peer.reply(from.name ?? from.id, message.id, "TOOL-ANSWER");
        }
      });
      await waitHubVisible(peer);

      const result = await started.hub.handleTool({ action: "ask", to: "peer", message: "tool question" });
      expect(result).toContain("TOOL-ANSWER");
      // The reply fed the tool result only — it must not become a session prompt.
      expect(fake.prompts).toHaveLength(0);
    } finally {
      started?.stop();
      peer.unregister();
      broker?.kill("SIGKILL");
      cleanupAgentDir(agentDir);
    }
  }, 25_000);
});
