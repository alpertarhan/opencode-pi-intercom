import { describe, expect, test } from "bun:test";
import { SessionBridge } from "../src/session.ts";
import type { SdkClient } from "../src/session.ts";
import type { IntercomPluginConfig } from "../src/config.ts";

const quietLog = () => {};

function makeCfg(overrides: Partial<IntercomPluginConfig> = {}): IntercomPluginConfig {
  return {
    enabled: true,
    name: "opencode",
    agentDir: "/tmp/agent",
    sessionID: null,
    bridgeModel: null,
    autoReply: false,
    inboundTrigger: "always",
    askTimeoutMs: 600_000,
    stableId: null,
    ...overrides,
  };
}

describe("SessionBridge.resolveTargetSession", () => {
  test("fixed config sessionID wins", async () => {
    const bridge = new SessionBridge({}, makeCfg({ sessionID: "ses_fixed" }), quietLog);
    expect(await bridge.resolveTargetSession()).toBe("ses_fixed");
  });

  test("tracked session from events wins over listing", async () => {
    const sdk: SdkClient = { session: { list: async () => ({ data: [{ id: "from-list" }] }) } };
    const bridge = new SessionBridge(sdk, makeCfg(), quietLog);
    bridge.trackEvent("message.updated", { info: { sessionID: "from-event" } });
    expect(await bridge.resolveTargetSession()).toBe("from-event");
  });

  test("falls back to the most recently updated session", async () => {
    const sdk: SdkClient = {
      session: { list: async () => ({ data: [{ id: "a", time: { updated: 1 } }, { id: "b", time: { updated: 9 } }] }) },
    };
    const bridge = new SessionBridge(sdk, makeCfg(), quietLog);
    expect(await bridge.resolveTargetSession()).toBe("b");
  });

  test("creates a session when none exist", async () => {
    const created: unknown[] = [];
    const sdk: SdkClient = {
      session: {
        list: async () => ({ data: [] }),
        create: async (args) => { created.push(args); return { data: { id: "brand-new" } }; },
      },
    };
    const bridge = new SessionBridge(sdk, makeCfg(), quietLog);
    expect(await bridge.resolveTargetSession()).toBe("brand-new");
    expect(created).toEqual([{ body: { title: "intercom" } }]);
  });
});

describe("SessionBridge.injectInto", () => {
  test("sends parts with the intercom text; noReply and bridgeModel only when set", async () => {
    const prompts: unknown[] = [];
    const sdk: SdkClient = { session: { prompt: async (args) => { prompts.push(args); } } };
    const bridge = new SessionBridge(sdk, makeCfg(), quietLog);
    await bridge.injectInto("ses_1", "hello", { noReply: false });
    await bridge.injectInto("ses_1", "quiet", { noReply: true });
    const bridge2 = new SessionBridge(
      { session: { prompt: async (args) => { prompts.push(args); } } } as SdkClient,
      makeCfg({ bridgeModel: { providerID: "opencode", modelID: "muse-spark-1.3" } }),
      quietLog,
    );
    await bridge2.injectInto("ses_2", "forced", { noReply: false });
    expect(prompts[0]).toEqual({ path: { id: "ses_1" }, body: { parts: [{ type: "text", text: "hello" }] } });
    expect(prompts[1]).toEqual({
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "quiet" }], noReply: true },
    });
    expect(prompts[2]).toEqual({
      path: { id: "ses_2" },
      body: {
        parts: [{ type: "text", text: "forced" }],
        model: { providerID: "opencode", modelID: "muse-spark-1.3" },
      },
    });
  });
});

describe("SessionBridge.lastAssistantText", () => {
  test("returns the newest assistant text parts joined", async () => {
    const sdk: SdkClient = {
      session: {
        messages: async () => ({
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "q" }] },
            { info: { role: "assistant" }, parts: [{ type: "text", text: "old answer" }] },
            { info: { role: "assistant" }, parts: [{ type: "reasoning" }, { type: "text", text: "part A" }, { type: "text", text: "part B" }] },
          ],
        }),
      },
    };
    const bridge = new SessionBridge(sdk, makeCfg(), quietLog);
    expect(await bridge.lastAssistantText("ses_1")).toBe("part A\npart B");
  });

  test("null when no assistant text exists", async () => {
    const sdk: SdkClient = {
      session: { messages: async () => ({ data: [{ info: { role: "user" }, parts: [] }] }) },
    };
    const bridge = new SessionBridge(sdk, makeCfg(), quietLog);
    expect(await bridge.lastAssistantText("ses_1")).toBeNull();
  });
});

describe("SessionBridge.trackEvent", () => {
  test("session.idle fires onIdle with the session id", () => {
    const bridge = new SessionBridge({}, makeCfg(), quietLog);
    const idle: string[] = [];
    bridge.onIdle = (id) => idle.push(id);
    bridge.trackEvent("session.idle", { sessionID: "ses_9" });
    expect(idle).toEqual(["ses_9"]);
  });

  test("session.status maps running states", () => {
    const bridge = new SessionBridge({}, makeCfg(), quietLog);
    const running: boolean[] = [];
    bridge.onRunning = (r) => running.push(r);
    bridge.trackEvent("session.status", { status: "running" });
    bridge.trackEvent("session.status", { status: "idle" });
    bridge.trackEvent("session.status", { status: "retry" });
    expect(running).toEqual([true, false, true]);
  });

  test("message.updated refreshes the model label", () => {
    const bridge = new SessionBridge({}, makeCfg(), quietLog);
    bridge.trackEvent("message.updated", { info: { sessionID: "s", providerID: "opencode", modelID: "muse-spark-1.3" } });
    expect(bridge.modelLabel).toBe("opencode/muse-spark-1.3");
  });
});

describe("SessionBridge.refreshModelLabel", () => {
  test("prefers default.build then default.plan", async () => {
    const a = new SessionBridge({ config: { providers: async () => ({ data: { default: { build: "p/b", plan: "p/p" } } }) } }, makeCfg(), quietLog);
    expect(await a.refreshModelLabel()).toBe("p/b");
    const b = new SessionBridge({ config: { providers: async () => ({ data: { default: { plan: "p/p" } } }) } }, makeCfg(), quietLog);
    expect(await b.refreshModelLabel()).toBe("p/p");
    const c = new SessionBridge({ config: { providers: async () => ({ data: {} }) } }, makeCfg(), quietLog);
    expect(await c.refreshModelLabel()).toBe("opencode");
  });
});
