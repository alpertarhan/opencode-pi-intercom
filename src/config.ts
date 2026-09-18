// Plugin configuration. Precedence: env > ~/.config/opencode/intercom.json >
// shared <agentDir>/intercom/config.json (the same file omp-intercom reads) > defaults.

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveAgentDir } from "./paths.ts";

export type InboundTriggerPolicy = "always" | "replies" | "never";

export interface IntercomPluginConfig {
  enabled: boolean;
  name: string;
  agentDir: string;
  /** Fixed OpenCode session that receives injected prompts; null = active/latest. */
  sessionID: string | null;
  /** "providerID/modelID" forced on injected prompts (e.g. "opencode/muse-spark-1.3"). */
  bridgeModel: { providerID: string; modelID: string } | null;
  autoReply: boolean;
  inboundTrigger: InboundTriggerPolicy;
  askTimeoutMs: number;
  stableId: string | null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function opencodeConfigDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return xdg ? join(xdg, "opencode") : join(home, ".config", "opencode");
}

const TRIGGERS: readonly string[] = ["always", "replies", "never"];

function coerceTrigger(value: unknown, fallback: "always" | "replies" | "never") {
  return typeof value === "string" && TRIGGERS.includes(value) ? value : fallback;
}

function coerceTimeoutMs(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseBridgeModel(value: unknown): IntercomPluginConfig["bridgeModel"] {
  if (typeof value !== "string" || !value.trim()) return null;
  const [providerID, modelID] = value.trim().split("/");
  return providerID && modelID ? { providerID, modelID } : null;
}

function envFlag(env: NodeJS.ProcessEnv, key: string): boolean | null {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IntercomPluginConfig {
  const pluginFile = readJsonObject(
    env.OPENCODE_INTERCOM_CONFIG ?? join(opencodeConfigDir(env), "intercom.json"),
  );

  const agentDir = resolveAgentDir(
    typeof pluginFile?.agentDir === "string" ? pluginFile.agentDir : null,
    env,
  );
  const sharedFile = readJsonObject(join(agentDir, "intercom", "config.json"));

  const enabled =
    envFlag(env, "OPENCODE_INTERCOM_ENABLED") ??
    (typeof pluginFile?.enabled === "boolean" ? pluginFile.enabled : null) ??
    (typeof sharedFile?.enabled === "boolean" ? sharedFile.enabled : true);

  const name =
    env.OPENCODE_INTERCOM_NAME?.trim() ||
    (typeof pluginFile?.name === "string" ? pluginFile.name.trim() : "") ||
    "opencode";

  const sessionID =
    env.OPENCODE_INTERCOM_SESSION_ID?.trim() ||
    (typeof pluginFile?.sessionID === "string" ? pluginFile.sessionID.trim() : "") ||
    null;

  const bridgeModel = parseBridgeModel(env.OPENCODE_INTERCOM_MODEL) ?? parseBridgeModel(pluginFile?.bridgeModel);

  const autoReply =
    envFlag(env, "OPENCODE_INTERCOM_AUTO_REPLY") ??
    (typeof pluginFile?.autoReply === "boolean" ? pluginFile.autoReply : false);

  const inboundTrigger = coerceTrigger(
    pluginFile?.inboundTrigger,
    coerceTrigger(sharedFile?.inboundTrigger, "always"),
  );

  const envAskTimeout = Number(env.PI_INTERCOM_ASK_TIMEOUT_MS?.trim());
  const askTimeoutMs =
    (Number.isSafeInteger(envAskTimeout) && envAskTimeout > 0 ? envAskTimeout : null) ??
    coerceTimeoutMs(pluginFile?.askTimeoutMs) ??
    10 * 60 * 1000;

  const stableId = typeof pluginFile?.stableId === "string" && pluginFile.stableId.trim() ? pluginFile.stableId.trim() : null;

  return { enabled, name, agentDir, sessionID, bridgeModel, autoReply, inboundTrigger, askTimeoutMs, stableId };
}
