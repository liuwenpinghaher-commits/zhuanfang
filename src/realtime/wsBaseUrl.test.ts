import { describe, expect, it } from "vitest";
import { deriveRealtimeWsBaseUrl } from "./wsBaseUrl";

describe("deriveRealtimeWsBaseUrl", () => {
  it("从非默认 HTTP API 端口派生同 host/port 的 ws 地址", () => {
    expect(deriveRealtimeWsBaseUrl("http://example.test:3310/api")).toBe("ws://example.test:3310");
  });

  it("HTTPS API 使用 wss", () => {
    expect(deriveRealtimeWsBaseUrl("https://voice.example.com/api")).toBe("wss://voice.example.com");
  });

  it("相对 API 地址使用页面同源", () => {
    expect(deriveRealtimeWsBaseUrl("/api", "https://product.example.com/app")).toBe("wss://product.example.com");
  });
});
