// IntercomClient — speaks the omp/pi-intercom broker protocol v1 over the
// shared Unix socket. Registration, presence, liveness heartbeat, send/ask/reply.

import { EventEmitter } from "events";
import net from "net";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.ts";
import { asBrokerMessage } from "./protocol.ts";
import type {
  Attachment,
  ClientMessage,
  Message,
  MessageReceiptStatus,
  SessionInfo,
  SessionRegistration,
} from "./protocol.ts";

export interface SendResult {
  id: string;
  delivered: boolean;
  reason?: string;
  delivery?: string;
}

export interface AskResult {
  replyText: string;
  fromName: string;
  messageId: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 5_000;

function livenessIntervalMs(): number {
  const raw = Number.parseInt(process.env.PI_INTERCOM_LIVENESS_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

function livenessTimeoutMs(): number {
  const raw = Number.parseInt(process.env.PI_INTERCOM_LIVENESS_TIMEOUT_MS ?? "", 10);
  const interval = livenessIntervalMs();
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, interval) : Math.min(5_000, interval);
}

export class IntercomClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private sessionId: string | null = null;
  private claimSessionId: string | null = null;
  private nextSequence = 1;
  private readonly pendingSends = new Map<string, (r: SendResult) => void>();
  private readonly pendingLists = new Map<string, (s: SessionInfo[]) => void>();
  private readonly pendingAsks = new Map<string, { resolve: (r: AskResult) => void; reject: (e: Error) => void }>();
  /** Replies that arrived before their ask was registered (bounded, 30s TTL). */
  private readonly earlyReplies = new Map<string, { from: SessionInfo; message: Message }>();
  private livenessTimer: NodeJS.Timeout | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private destroyed = false;

  get id(): string | null {
    return this.sessionId;
  }

  isConnected(): boolean {
    return Boolean(
      this.socket && this.sessionId && !this.destroyed && !this.socket.destroyed && this.socket.writable,
    );
  }

  async connect(
    socketPath: string,
    registration: SessionRegistration,
    claimSessionId?: string | null,
  ): Promise<void> {
    this.destroyed = false;
    this.claimSessionId = claimSessionId ?? this.claimSessionId ?? null;

    // Tear down any stale socket first; its late "close" must not clobber the
    // new connection (teardown ignores closes from a superseded socket).
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }

    const socket = net.connect(socketPath);
    this.socket = socket;

    const reader = createMessageReader(
      (raw) => this.handleFrame(raw),
      (error) => {
        this.emit("protocol-error", error);
        socket.destroy();
      },
    );
    socket.on("data", reader);
    socket.on("error", (error) => this.emit("socket-error", error));
    socket.on("close", () => this.teardown(socket));

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.connectReject = reject;
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("intercom connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    timeout.unref?.();
    this.once("_registered", () => {
      clearTimeout(timeout);
      this.connectReject = null;
      resolve();
    });

    const scopeId = process.env.PI_INTERCOM_SCOPE_ID?.trim() || undefined;
    const frame: ClientMessage = {
      type: "register",
      session: registration,
      ...(this.claimSessionId ? { sessionId: this.claimSessionId } : {}),
      ...(scopeId ? { scopeId } : {}),
    };
    writeMessage(socket, frame);
    await promise;
  }

  private teardown(closedSocket: net.Socket): void {
    // A close from a socket we already replaced is not a disconnect of the
    // current connection.
    if (this.socket !== closedSocket) return;
    this.stopLiveness();
    const wasRegistered = this.sessionId !== null;
    const error = new Error("client disconnected");
    for (const resolve of this.pendingSends.values()) {
      resolve({ id: "", delivered: false, reason: "disconnected" });
    }
    this.pendingSends.clear();
    for (const resolve of this.pendingLists.values()) resolve([]);
    this.pendingLists.clear();
    for (const ask of this.pendingAsks.values()) ask.reject(error);
    this.pendingAsks.clear();
    this.earlyReplies.clear();
    this.socket = null;
    this.sessionId = null;
    if (this.connectReject) {
      this.connectReject(new Error("connection closed before registration"));
      this.connectReject = null;
    }
    if (wasRegistered) this.emit("disconnected", error);
  }

  private handleFrame(raw: unknown): void {
    const msg = asBrokerMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "registered": {
        this.sessionId = msg.sessionId;
        this.claimSessionId = msg.sessionId;
        this.startLiveness();
        this.emit("_registered");
        this.emit("registered", msg.sessionId, msg.features ?? []);
        break;
      }
      case "sessions": {
        const resolve = this.pendingLists.get(msg.requestId);
        if (resolve) {
          this.pendingLists.delete(msg.requestId);
          resolve(Array.isArray(msg.sessions) ? msg.sessions : []);
        }
        break;
      }
      case "message": {
        const replyTo = msg.message.replyTo;
        const ask = replyTo ? this.pendingAsks.get(replyTo) : undefined;
        if (ask && replyTo) {
          this.pendingAsks.delete(replyTo);
          ask.resolve({
            replyText: msg.message.content.text,
            fromName: msg.from.name ?? msg.from.id.slice(0, 8),
            messageId: msg.message.id,
          });
        } else if (replyTo) {
          // Reply raced ahead of the ask's own registration (same-chunk
          // delivery): buffer it so ask() can still resolve.
          this.rememberEarlyReply(replyTo, msg.from, msg.message);
        }
        this.emit("message", msg.from, msg.message);
        break;
      }
      case "delivered": {
        const resolve = this.pendingSends.get(msg.messageId);
        if (resolve) {
          this.pendingSends.delete(msg.messageId);
          resolve({ id: msg.messageId, delivered: msg.delivery !== "failed", delivery: msg.delivery });
        }
        break;
      }
      case "delivery_failed": {
        const resolve = this.pendingSends.get(msg.messageId);
        if (resolve) {
          this.pendingSends.delete(msg.messageId);
          resolve({ id: msg.messageId, delivered: false, reason: msg.reason, delivery: msg.delivery });
        }
        break;
      }
      case "message_receipt":
        this.emit("receipt", msg.from, msg.receipt);
        break;
      case "presence_update":
        this.emit("presence", msg.session);
        break;
      case "session_joined":
        this.emit("peer-joined", msg.session);
        break;
      case "session_left":
        this.emit("peer-left", msg.sessionId);
        break;
      case "error":
        for (const resolve of this.pendingSends.values()) {
          resolve({ id: "", delivered: false, reason: msg.error });
        }
        this.pendingSends.clear();
        for (const ask of this.pendingAsks.values()) ask.reject(new Error(msg.error));
        this.pendingAsks.clear();
        this.emit("broker-error", msg.error);
        break;
      default:
        break;
    }
  }

  private requireSocket(): net.Socket {
    if (this.destroyed || !this.socket || !this.sessionId || this.socket.destroyed || !this.socket.writable) {
      throw new Error("intercom client is not connected");
    }
    return this.socket;
  }

  private safeWrite(frame: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return;
    try {
      writeMessage(socket, frame);
    } catch (error) {
      this.emit("socket-error", error);
    }
  }

  private startLiveness(): void {
    this.stopLiveness();
    this.livenessTimer = setInterval(() => {
      void this.list(livenessTimeoutMs()).catch(() => {
        // Half-open socket: broker gone without a close event. Destroy so the
        // close handler emits "disconnected" and the host reconnects.
        const socket = this.socket;
        if (socket && !socket.destroyed) socket.destroy();
      });
    }, livenessIntervalMs());
    this.livenessTimer.unref?.();
  }

  /** Bound the early-reply buffer: drop entries older than 30s, cap at 100. */
  private rememberEarlyReply(replyTo: string, from: SessionInfo, message: Message): void {
    const now = Date.now();
    for (const [key, entry] of this.earlyReplies) {
      if (now - entry.message.timestamp > 30_000) this.earlyReplies.delete(key);
    }
    while (this.earlyReplies.size >= 100) {
      const oldest = this.earlyReplies.keys().next().value;
      if (oldest === undefined) break;
      this.earlyReplies.delete(oldest);
    }
    this.earlyReplies.set(replyTo, { from, message });
  }

  private stopLiveness(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  async send(
    to: string,
    text: string,
    opts: { expectsReply?: boolean; replyTo?: string; attachments?: Attachment[]; targetId?: string; targetEpoch?: string } = {},
  ): Promise<SendResult> {
    const socket = this.requireSocket();
    const id = randomUUID();
    const message: Message = {
      id,
      timestamp: Date.now(),
      senderSequence: this.nextSequence++,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.expectsReply ? { expectsReply: true } : {}),
      content: {
        text,
        ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      },
    };
    const { promise, resolve } = Promise.withResolvers<SendResult>();
    this.pendingSends.set(id, resolve);
    const timer = setTimeout(() => {
      if (this.pendingSends.delete(id)) {
        resolve({ id, delivered: false, reason: "send acknowledgement timeout" });
      }
    }, SEND_TIMEOUT_MS);
    timer.unref?.();
    writeMessage(socket, {
      type: "send",
      to,
      message,
      ...(opts.targetId ? { targetId: opts.targetId } : {}),
      ...(opts.targetEpoch ? { targetEpoch: opts.targetEpoch } : {}),
    });
    const result = await promise;
    clearTimeout(timer);
    return result;
  }

  async ask(
    to: string,
    text: string,
    timeoutMs: number,
    onSent?: (askMessageId: string) => void,
  ): Promise<AskResult> {
    const sent = await this.send(to, text, { expectsReply: true });
    if (!sent.delivered) throw new Error(`ask not delivered: ${sent.reason ?? "unknown reason"}`);
    onSent?.(sent.id);
    const { promise, resolve, reject } = Promise.withResolvers<AskResult>();
    const timer = setTimeout(() => {
      if (this.pendingAsks.delete(sent.id)) {
        this.safeWrite({ type: "cancel_ask", messageId: sent.id });
        reject(new Error(`ask to "${to}" timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);
    timer.unref?.();
    const early = this.earlyReplies.get(sent.id);
    if (early) {
      this.earlyReplies.delete(sent.id);
      clearTimeout(timer);
      return {
        replyText: early.message.content.text,
        fromName: early.from.name ?? early.from.id.slice(0, 8),
        messageId: early.message.id,
      };
    }
    this.pendingAsks.set(sent.id, { resolve, reject });
    try {
      return await promise;
    } finally {
      clearTimeout(timer);
    }
  }

  async reply(to: string, replyTo: string, text: string): Promise<SendResult> {
    return this.send(to, text, { replyTo });
  }

  async list(timeoutMs: number = LIST_TIMEOUT_MS): Promise<SessionInfo[]> {
    const socket = this.requireSocket();
    const requestId = randomUUID();
    const { promise, resolve } = Promise.withResolvers<SessionInfo[]>();
    this.pendingLists.set(requestId, resolve);
    const timer = setTimeout(() => {
      if (this.pendingLists.delete(requestId)) resolve([]);
    }, timeoutMs);
    timer.unref?.();
    writeMessage(socket, { type: "list", requestId });
    const sessions = await promise;
    clearTimeout(timer);
    return sessions;
  }

  presence(fields: { status?: string; model?: string; name?: string }): void {
    this.safeWrite({
      type: "presence",
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.status ? { status: fields.status } : {}),
      ...(fields.model ? { model: fields.model } : {}),
    });
  }

  sendReceipt(messageId: string, status: MessageReceiptStatus, detail?: string): void {
    this.safeWrite({
      type: "message_receipt",
      receipt: { messageId, status, timestamp: Date.now(), ...(detail ? { detail } : {}) },
    });
  }

  unregister(): void {
    this.destroyed = true;
    this.safeWrite({ type: "unregister" });
    this.stopLiveness();
    this.socket?.destroy();
  }
}
