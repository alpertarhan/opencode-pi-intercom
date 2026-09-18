// Broker path resolution. Mirrors omp-intercom's paths.ts so this plugin and
// the omp/pi extensions converge on the same broker:
//   1. explicit plugin config `agentDir` (~/.config/opencode/intercom.json)
//   2. PI_CODING_AGENT_DIR (the same env omp/pi intercom honor)
//   3. default OMP agent dir: ~/.omp/agent
// Point `agentDir` at ~/.pi/agent to join a pi-intercom roster instead.

import { chmodSync, mkdirSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";

export const INTERCOM_DIR_MODE = 0o700;

export function resolveAgentDir(explicit?: string | null, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const configured = explicit?.trim() || env.PI_CODING_AGENT_DIR?.trim();
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }
  return join(home, ".omp/agent");
}

export function getIntercomDir(agentDir: string): string {
  return join(agentDir, "intercom");
}

export function getBrokerSocketPath(agentDir: string): string {
  return join(getIntercomDir(agentDir), "broker.sock");
}

export function ensureIntercomDir(agentDir: string): void {
  const dir = getIntercomDir(agentDir);
  mkdirSync(dir, { recursive: true, mode: INTERCOM_DIR_MODE });
  try {
    chmodSync(dir, INTERCOM_DIR_MODE);
  } catch {
    // best effort outside our control (read-only home, exotic perms)
  }
}
