import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../src/config.ts";
import { cleanupAgentDir, tmpAgentDir } from "./helpers.ts";

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

const baseEnv = { HOME: "/home/tester" };

describe("loadConfig defaults", () => {
  test("no files, no env → omp defaults", () => {
    const cfg = loadConfig({ ...baseEnv, OPENCODE_INTERCOM_CONFIG: "/nonexistent/intercom.json" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.name).toBe("opencode");
    expect(cfg.agentDir).toBe("/home/tester/.omp/agent");
    expect(cfg.sessionID).toBeNull();
    expect(cfg.bridgeModel).toBeNull();
    expect(cfg.autoReply).toBe(false);
    expect(cfg.inboundTrigger).toBe("always");
    expect(cfg.askTimeoutMs).toBe(600_000);
    expect(cfg.stableId).toBeNull();
  });
});

describe("loadConfig precedence", () => {
  test("plugin file values apply", () => {
    const dir = tmpAgentDir();
    const pluginCfg = join(dir, "intercom.json");
    writeJson(pluginCfg, {
      enabled: true,
      name: "opencode-dev",
      sessionID: "ses_x",
      bridgeModel: "opencode/muse-spark-1.3",
      autoReply: true,
      inboundTrigger: "replies",
      askTimeoutMs: 1234,
      stableId: "stable-1",
    });
    const cfg = loadConfig({ ...baseEnv, OPENCODE_INTERCOM_CONFIG: pluginCfg });
    expect(cfg.name).toBe("opencode-dev");
    expect(cfg.sessionID).toBe("ses_x");
    expect(cfg.bridgeModel).toEqual({ providerID: "opencode", modelID: "muse-spark-1.3" });
    expect(cfg.autoReply).toBe(true);
    expect(cfg.inboundTrigger).toBe("replies");
    expect(cfg.askTimeoutMs).toBe(1234);
    expect(cfg.stableId).toBe("stable-1");
    cleanupAgentDir(dir);
  });

  test("plugin file agentDir steers the shared-config lookup", () => {
    const dir = tmpAgentDir();
    writeJson(join(dir, "intercom", "config.json"), { inboundTrigger: "never", enabled: false });
    const pluginCfg = join(dir, "plugin.json");
    writeJson(pluginCfg, { agentDir: dir, inboundTrigger: "replies" });
    const cfg = loadConfig({ ...baseEnv, OPENCODE_INTERCOM_CONFIG: pluginCfg });
    // plugin file wins for inboundTrigger; shared file still supplies enabled
    expect(cfg.inboundTrigger).toBe("replies");
    expect(cfg.enabled).toBe(false);
    cleanupAgentDir(dir);
  });

  test("env beats the plugin file", () => {
    const dir = tmpAgentDir();
    const pluginCfg = join(dir, "intercom.json");
    writeJson(pluginCfg, { name: "from-file", autoReply: true, enabled: true });
    const cfg = loadConfig({
      ...baseEnv,
      OPENCODE_INTERCOM_CONFIG: pluginCfg,
      OPENCODE_INTERCOM_NAME: "from-env",
      OPENCODE_INTERCOM_AUTO_REPLY: "0",
      OPENCODE_INTERCOM_ENABLED: "false",
      PI_INTERCOM_ASK_TIMEOUT_MS: "4242",
    });
    expect(cfg.name).toBe("from-env");
    expect(cfg.autoReply).toBe(false);
    expect(cfg.enabled).toBe(false);
    expect(cfg.askTimeoutMs).toBe(4242);
    cleanupAgentDir(dir);
  });

  test("invalid values fall back to defaults", () => {
    const dir = tmpAgentDir();
    const pluginCfg = join(dir, "intercom.json");
    writeJson(pluginCfg, { inboundTrigger: "sometimes", bridgeModel: "no-slash", askTimeoutMs: -5 });
    const cfg = loadConfig({ ...baseEnv, OPENCODE_INTERCOM_CONFIG: pluginCfg, PI_INTERCOM_ASK_TIMEOUT_MS: "abc" });
    expect(cfg.inboundTrigger).toBe("always");
    expect(cfg.bridgeModel).toBeNull();
    expect(cfg.askTimeoutMs).toBe(600_000);
    cleanupAgentDir(dir);
  });
});
