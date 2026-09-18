// Broker discovery / spawn. The broker binary belongs to omp-intercom (or
// pi-intercom); this plugin never ships its own copy — it reuses the installed
// one so there is exactly one broker per agent dir, matching the omp/pi
// extensions' spawn contract (broker.pid, socket bind as single-instance guard).

import { existsSync, readFileSync, rmSync } from "fs";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { ensureIntercomDir, getBrokerSocketPath, getIntercomDir } from "./paths.ts";

export function findBrokerScript(agentDir: string): string | null {
  const pluginsRoot = join(dirname(agentDir), "plugins", "node_modules");
  const candidates = [
    join(pluginsRoot, "omp-intercom", "broker", "broker.ts"),
    join(pluginsRoot, "pi-intercom", "broker", "broker.ts"),
    join(agentDir, "plugins", "node_modules", "omp-intercom", "broker", "broker.ts"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function readBrokerPid(intercomDir: string): number | null {
  const pidFile = join(intercomDir, "broker.pid");
  if (!existsSync(pidFile)) return null;
  const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Make sure a broker is listening on <agentDir>/intercom/broker.sock.
 * Spawns the installed omp/pi-intercom broker when missing (bun runs the TS
 * source natively; node >= 23 strips types). Resolves once the socket exists.
 */
export async function ensureBroker(agentDir: string, log: (...args: unknown[]) => void): Promise<void> {
  const socketPath = getBrokerSocketPath(agentDir);
  const intercomDir = getIntercomDir(agentDir);

  if (existsSync(socketPath)) {
    const pid = readBrokerPid(intercomDir);
    // No pid file yet can mean the broker is mid-startup (it writes the pid
    // right after binding) — treat as alive. Only a recorded DEAD pid proves
    // the socket is stale; anything else must not be touched.
    if (pid === null || pidAlive(pid)) return;
    try {
      rmSync(socketPath);
    } catch (error) {
      log(`could not remove stale broker socket: ${String(error)}`);
    }
  }

  const script = findBrokerScript(agentDir);
  if (!script) {
    throw new Error(
      `no intercom broker found for ${agentDir} — install omp-intercom (omp install npm:omp-intercom) ` +
        `or set "agentDir" in ~/.config/opencode/intercom.json to a directory that has one`,
    );
  }

  ensureIntercomDir(agentDir);
  const command = process.versions?.bun ? process.execPath : "node";
  log(`spawning intercom broker: ${command} ${script}`);
  const child = spawn(command, [script], {
    detached: true,
    stdio: "ignore",
    cwd: dirname(script),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
  });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return;
    await sleep(150);
  }
  throw new Error(`intercom broker did not come up at ${socketPath} within 10s`);
}
