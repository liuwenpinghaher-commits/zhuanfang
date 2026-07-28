import { describe, expect, it } from "vitest";
import {
  deriveRealtimeApiWsBaseUrl,
  withAuthTokenQuery,
  resolveProductApiToken,
} from "./productApi";

describe("deriveRealtimeApiWsBaseUrl", () => {
  it("derives ws host/port from configured product API base (non-default port)", () => {
    expect(deriveRealtimeApiWsBaseUrl("http://127.0.0.1:3310")).toBe("ws://127.0.0.1:3310");
    expect(deriveRealtimeApiWsBaseUrl("https://api.example.com")).toBe("wss://api.example.com");
  });
});

describe("withAuthTokenQuery", () => {
  it("appends token query for WS auth", () => {
    const url = withAuthTokenQuery("ws://127.0.0.1:3210/api/realtime-voice/ws/s1", "secret-token");
    expect(url).toContain("token=secret-token");
    expect(url.startsWith("ws://127.0.0.1:3210/api/realtime-voice/ws/s1")).toBe(true);
  });

  it("leaves URL unchanged when token empty", () => {
    expect(withAuthTokenQuery("ws://127.0.0.1:3210/x", "")).toBe("ws://127.0.0.1:3210/x");
  });
});

describe("resolveProductApiToken", () => {
  it("returns a string in test harness", () => {
    expect(typeof resolveProductApiToken()).toBe("string");
  });
});
