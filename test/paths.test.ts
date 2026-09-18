import { describe, expect, test } from "bun:test";
import { getBrokerSocketPath, getIntercomDir, resolveAgentDir } from "../src/paths.ts";
import { isAbsolute, join } from "path";

describe("resolveAgentDir", () => {
  test("defaults to ~/.omp/agent", () => {
    const home = "/home/tester";
    expect(resolveAgentDir(null, { HOME: home })).toBe(join(home, ".omp/agent"));
  });

  test("honors PI_CODING_AGENT_DIR", () => {
    expect(resolveAgentDir(null, { HOME: "/h", PI_CODING_AGENT_DIR: "/custom/dir" })).toBe("/custom/dir");
  });

  test("resolves a relative PI_CODING_AGENT_DIR against cwd", () => {
    const resolved = resolveAgentDir(null, { HOME: "/h", PI_CODING_AGENT_DIR: "rel/dir" });
    expect(isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(join("rel", "dir"))).toBe(true);
  });

  test("explicit config wins over env", () => {
    expect(resolveAgentDir("/explicit", { HOME: "/h", PI_CODING_AGENT_DIR: "/from-env" })).toBe("/explicit");
  });
});

describe("broker paths", () => {
  test("socket lives under <agentDir>/intercom/broker.sock", () => {
    expect(getBrokerSocketPath("/agents/a1")).toBe(join("/agents", "a1", "intercom", "broker.sock"));
    expect(getIntercomDir("/agents/a1")).toBe(join("/agents", "a1", "intercom"));
  });
});
