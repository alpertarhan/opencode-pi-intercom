import { describe, expect, test } from "bun:test";
import { createMessageReader, writeMessage } from "../src/framing.ts";

function fakeSocket(collector: Buffer[]): { write: (data: Buffer) => boolean } {
  return { write: (data: Buffer) => { collector.push(Buffer.from(data)); return true; } };
}

function frameOf(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

describe("writeMessage", () => {
  test("emits 4-byte big-endian length + JSON payload", () => {
    const chunks: Buffer[] = [];
    writeMessage(fakeSocket(chunks) as never, { type: "list", requestId: "r1" });
    const frame = Buffer.concat(chunks);
    expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
    expect(JSON.parse(frame.subarray(4).toString("utf-8"))).toEqual({ type: "list", requestId: "r1" });
  });
});

describe("createMessageReader", () => {
  test("parses a frame delivered in one chunk", () => {
    const received: unknown[] = [];
    const reader = createMessageReader((msg) => received.push(msg), () => {});
    reader(frameOf({ hello: 1 }));
    expect(received).toEqual([{ hello: 1 }]);
  });

  test("reassembles a frame split into single-byte drips", () => {
    const received: unknown[] = [];
    const reader = createMessageReader((msg) => received.push(msg), () => {});
    const frame = frameOf({ type: "registered", sessionId: "abc" });
    for (const byte of frame) {
      reader(Buffer.from([byte]));
    }
    expect(received).toEqual([{ type: "registered", sessionId: "abc" }]);
  });

  test("parses multiple frames packed into one chunk", () => {
    const received: unknown[] = [];
    const reader = createMessageReader((msg) => received.push(msg), () => {});
    reader(Buffer.concat([frameOf({ n: 1 }), frameOf({ n: 2 }), frameOf({ n: 3 })]));
    expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("rejects an oversized frame and recovers on the next frame", () => {
    const errors: Error[] = [];
    const received: unknown[] = [];
    const reader = createMessageReader((msg) => received.push(msg), (e) => errors.push(e), 64);
    const big = Buffer.alloc(4 + 200);
    big.writeUInt32BE(200, 0);
    reader(big);
    reader(frameOf({ ok: true }));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("exceeds maximum");
    expect(received).toEqual([{ ok: true }]);
  });

  test("reports malformed JSON payload", () => {
    const errors: Error[] = [];
    const reader = createMessageReader(() => {}, (e) => errors.push(e));
    const bad = Buffer.from("not-json", "utf-8");
    const frame = Buffer.alloc(4 + bad.length);
    frame.writeUInt32BE(bad.length, 0);
    bad.copy(frame, 4);
    reader(frame);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Failed to parse");
  });
});
