// Inbound broker message → OpenCode prompt text (mirrors omp-intercom's
// inline rendering: sender header, attachments, reply hint).

import type { Message, SessionInfo } from "./protocol.ts";

export function formatInboundPrompt(from: SessionInfo, message: Message): string {
  const sender = from.name ?? from.id.slice(0, 8);
  const lines: string[] = [`[intercom] Message from ${sender} (cwd: ${from.cwd})`];
  if (message.expectsReply) {
    lines.push(
      "[intercom] This message expects a reply. When you are done, answer with the intercom tool:",
      '[intercom]   intercom({ "action": "reply", "message": "<your answer>" })',
    );
  }
  lines.push("", message.content.text);
  for (const attachment of message.content.attachments ?? []) {
    lines.push("", `--- attachment: ${attachment.name}${attachment.language ? ` (${attachment.language})` : ""} ---`, "```" + (attachment.language ?? ""), attachment.content, "```");
  }
  return lines.join("\n");
}
