import { describe, expect, test } from "bun:test";
import { asBrokerMessage } from "../src/protocol.ts";

describe("asBrokerMessage", () => {
  test("accepts an object with a string type", () => {
    expect(asBrokerMessage({ type: "registered", sessionId: "s1" })).toEqual({
      type: "registered",
      sessionId: "s1",
    });
  });

  test("rejects non-objects", () => {
    expect(asBrokerMessage(null)).toBeNull();
    expect(asBrokerMessage(42)).toBeNull();
    expect(asBrokerMessage("registered")).toBeNull();
    expect(asBrokerMessage([1, 2])).toBeNull();
  });

  test("rejects objects without a string type", () => {
    expect(asBrokerMessage({})).toBeNull();
    expect(asBrokerMessage({ type: 7 })).toBeNull();
  });
});
