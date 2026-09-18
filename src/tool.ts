// The `intercom` tool exposed to the OpenCode agent — action surface mirrors
// the omp/pi-intercom tool so orchestration prompts read the same on both sides.
//
// The "@opencode-ai/plugin" import is runtime-optional: dev builds of OpenCode
// pin a version that does not exist on npm, so the package resolves only where
// a compatible one is installed (stable builds, or the explicit dependency in
// ~/.config/opencode/package.json). A static import would kill the whole plugin
// on those builds, hence the guarded dynamic import. Without the helper the
// plugin still registers, receives and injects messages — only the
// agent-facing tool is absent.

export interface IntercomToolArgs {
  action: "list" | "list-cwd" | "send" | "ask" | "reply" | "status";
  to?: string;
  message?: string;
  replyTo?: string;
  cwd?: string;
}

export interface IntercomHubApi {
  handleTool(args: IntercomToolArgs): Promise<string>;
}

/** Minimal structural view of the plugin package (it may be absent at runtime). */
interface PluginModule {
  tool: ((def: unknown) => unknown) & { schema: Record<string, (...args: unknown[]) => unknown> };
}

export async function makeIntercomTool(
  hub: IntercomHubApi,
  log: (...args: unknown[]) => void,
): Promise<unknown | null> {
  let helper: PluginModule;
  try {
    helper = (await import("@opencode-ai/plugin")) as PluginModule;
  } catch (error) {
    log(`@opencode-ai/plugin unavailable — intercom tool disabled, messaging still active (${String(error)})`);
    return null;
  }
  const s = helper.tool.schema;
  return helper.tool({
    description:
      "Direct messaging with other intercom sessions on this machine (omp / pi / opencode agents). " +
      '"list" shows connected sessions; "send" is fire-and-forget; "ask" blocks until the target replies ' +
      "(use for questions you cannot proceed without); \"reply\" answers a pending inbound ask; " +
      '"status" shows the local connection state.',
    args: {
      action: s.enum(["list", "list-cwd", "send", "ask", "reply", "status"]).describe("Intercom action"),
      to: s.string().optional().describe('Target session name or id, e.g. "research" (send/ask)'),
      message: s.string().optional().describe("Message text (send/ask/reply)"),
      replyTo: s.string().optional().describe("Message id being replied to (reply; inferred when omitted)"),
      cwd: s.string().optional().describe("Target the sole live session in this directory (send/ask)"),
    },
    async execute(args: IntercomToolArgs) {
      return hub.handleTool(args);
    },
  });
}
