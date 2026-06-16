import { expect, test } from "@playwright/test";
import {
  createInitialProductState,
  createSessionDraft,
  finalizeSession,
  receiveUserTurnWithAssistant
} from "../../src/domain/engine";
import type { InterviewSession, ProductState } from "../../src/domain/types";
import { expectNoHorizontalOverflow, openView, resetDemoState } from "./helpers";

test("runs the interview workflow through the Product API", async ({ page }) => {
  let storedState: ProductState = createInitialProductState();
  let activeSession: InterviewSession | undefined;
  const apiCalls: string[] = [];

  await page.route("http://127.0.0.1:8787/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    apiCalls.push(`${request.method()} ${url.pathname}`);

    if (url.pathname === "/api/state" && request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storedState) });
      return;
    }

    if (url.pathname === "/api/state" && request.method() === "PUT") {
      storedState = JSON.parse(request.postData() ?? "{}") as ProductState;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(storedState) });
      return;
    }

    if (url.pathname === "/api/interview-sessions" && request.method() === "POST") {
      activeSession = createSessionDraft(storedState, "decision", "standard");
      storedState = {
        ...storedState,
        sessions: [activeSession, ...storedState.sessions]
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: activeSession, state: storedState })
      });
      return;
    }

    if (url.pathname.endsWith("/turns") && request.method() === "POST" && activeSession) {
      const payload = JSON.parse(request.postData() ?? "{}") as { content: string };
      activeSession = receiveUserTurnWithAssistant(activeSession, payload.content, {
        content: "API 追问：先把失控拆成延期、质量、客户和团队信任四类。",
        intent: "百炼角色扮演追问"
      });
      storedState = {
        ...storedState,
        sessions: [activeSession, ...storedState.sessions.filter((session) => session.id !== activeSession?.id)]
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: activeSession, state: storedState })
      });
      return;
    }

    if (url.pathname.endsWith("/end") && request.method() === "POST" && activeSession) {
      const baseState = {
        ...storedState,
        sessions: storedState.sessions.filter((session) => session.id !== activeSession?.id)
      };
      const result = finalizeSession(baseState, activeSession);
      storedState = result.nextState;
      activeSession = result.nextState.sessions[0];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ session: activeSession, note: result.note, state: storedState })
      });
      return;
    }

    if (url.pathname === "/api/realtime-voice/sessions" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          provider: "bailian",
          model: "qwen3.5-omni-plus-realtime",
          fallbackModel: "qwen3.5-omni-flash-realtime",
          transport: "webrtc",
          fallbackTransport: "websocket",
          vad: "server_vad",
          enableSearch: false,
          configured: true,
          apiKeyConfigured: true,
          webrtcEndpointConfigured: true,
          requiresServerSession: true,
          sessionId: "rtv-e2e",
          status: "ready",
          signaling: {
            method: "POST",
            path: "/api/realtime-voice/sessions/rtv-e2e/webrtc/answer",
            contentType: "application/sdp"
          },
          sessionUpdate: {
            type: "session.update",
            session: {
              modalities: ["text", "audio"],
              voice: "Ethan",
              input_audio_format: "pcm",
              output_audio_format: "pcm",
              instructions: "你是一个真正的私人专访主持人。",
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                silence_duration_ms: 800
              }
            }
          },
          interviewSessionId: activeSession?.id,
          expiresAt: "2026-06-10T00:10:00.000Z"
        })
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not mocked" }) });
  });

  await resetDemoState(page);
  await openView(page, "实时专访", "专访启动");
  await page.getByRole("button", { name: "开始专访" }).click();
  await expect(page.getByRole("button", { name: "提交表达" })).toBeVisible();
  // Click the mic toggle (aria-label "开始录音" when idle) to trigger POST /api/realtime-voice/sessions.
  // After the mocked session response is returned, the subtitle reflects the transport mode immediately
  // (before any WebRTC/WebSocket connection attempt). We assert on the subtitle's transport badge.
  await page.getByRole("button", { name: "开始录音" }).click();
  await expect(page.getByText("WebRTC 实时语音")).toBeVisible();

  await page.getByLabel("你的回答").fill("我怕放手后项目失控。");
  await page.getByRole("button", { name: "提交表达" }).click();

  await expect(page.getByText("API 追问：先把失控拆成延期、质量、客户和团队信任四类。")).toBeVisible();
  await expect(page.getByText("百炼角色扮演追问")).toBeVisible();

  await page.getByRole("button", { name: "结束并生成档案" }).click();
  await expect(page.getByText("专访档案已生成")).toBeVisible();
  await expect(page.getByText("从访谈沉淀认知资产")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  expect(apiCalls).toContain("POST /api/interview-sessions");
  expect(apiCalls).toContain("POST /api/realtime-voice/sessions");
  expect(apiCalls.some((call) => call.endsWith("/turns"))).toBe(true);
  expect(apiCalls.some((call) => call.endsWith("/end"))).toBe(true);
});
