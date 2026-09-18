// Shared helpers for the test suite.

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureIntercomDir, getBrokerSocketPath } from "../src/paths.ts";
import type { SessionRegistration } from "../src/protocol.ts";

export const REAL_BROKER =
  process.env.INTERCOM_TEST_BROKER ??
  join(process.env.HOME ?? "~", ".omp/plugins/node_modules/omp-intercom/broker/broker.ts");

export function hasRealBroker(): boolean {
  return existsSync(REAL_BROKER);
}

export function tmpAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-intercom-"));
}

export function cleanupAgentDir(agentDir: string): void {
  rmSync(agentDir, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function waitFor(
  claim: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await claim()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Spawn the real omp-intercom broker against an isolated agent dir. */
export async function startRealBroker(agentDir: string): Promise<ChildProcess> {
  ensureIntercomDir(agentDir);
  const child = spawn(process.execPath, [REAL_BROKER], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
    stdio: "ignore",
  });
  const socketPath = getBrokerSocketPath(agentDir);
  try {
    await waitFor(() => existsSync(socketPath), 10_000, "real broker socket");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return child;
}

export function registration(name: string): SessionRegistration {
  return {
    cwd: `/tmp/oc-intercom-test-${name}`,
    model: "test-model",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    name,
    status: "idle",
  };
}
