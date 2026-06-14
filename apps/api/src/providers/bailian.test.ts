import { describe, expect, it, vi } from "vitest";
import {
  createBailianAudioTranscriptionClient,
  createBailianCharacterInterviewClient,
  createBailianPodcastAudioClient,
  createBailianRealtimeVoiceClient,
  createBailianSearchClient
} from "./bailian";
import { createInitialProductState, createSessionDraft } from "../../../../src/domain/engine";

describe("bailian provider client", () => {
  it("uses qwen3.7-plus Responses API with built-in web tools for search briefs", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            summary: "百炼联网搜索整合后的主题摘要。",
            discussionTopics: ["讨论主题 A", "讨论主题 B"],
            sourceAngles: ["来源角度 A"],
            sources: [
              {
                title: "AI 产品商业化热点",
                url: "https://example.com/ai-product",
                publisher: "Example News",
                publishedAt: "2026-06-10T00:00:00.000Z",
                snippet: "热点素材摘要",
                relevanceScore: 0.92,
                usage: "topic-suggestion"
              }
            ]
          })
        }),
        { status: 200 }
      )
    );
    const client = createBailianSearchClient({
      apiKey: "test-key",
      fetchImpl
    });

    const result = await client.createSearchBrief({
      topic: "AI 产品商业化热点",
      providerId: "bailian",
      maxSources: 3,
      recencyDays: 14
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json"
        }
      })
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(requestBody).toMatchObject({
      model: "qwen3.7-plus",
      tools: [{ type: "web_search" }, { type: "web_extractor" }, { type: "code_interpreter" }]
    });
    expect(requestBody.input).toContain("AI 产品商业化热点");
    expect(result.provider).toBe("bailian");
    expect(result.status).toBe("ready");
    expect(result.sources[0]).toMatchObject({
      publisher: "Example News",
      usage: "topic-suggestion"
    });
  });

  it("uses CosyVoice v3-plus for rendered podcast audio by default", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: {
            audio: {
              url: "https://dashscope-result.example.com/podcast.mp3",
              expires_at: 1791705600
            }
          },
          request_id: "request-cosyvoice"
        }),
        { status: 200 }
      )
    );
    const client = createBailianPodcastAudioClient({
      apiKey: "test-key",
      fetchImpl
    });

    const result = await client.synthesize({
      text: "开场：这是一段确认后的播客脚本。"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json"
        }
      })
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(requestBody).toMatchObject({
      model: "cosyvoice-v3-plus",
      input: {
        text: "开场：这是一段确认后的播客脚本。",
        voice: "longyuan_v3",
        format: "mp3",
        sample_rate: 24000
      }
    });
    expect(result).toEqual({
      providerId: "bailian-cosyvoice",
      model: "cosyvoice-v3-plus",
      voice: "longyuan_v3",
      audioUrl: "https://dashscope-result.example.com/podcast.mp3",
      expiresAt: 1791705600
    });
  });

  it("submits and reads SenseVoice transcription tasks for imported audio", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              task_status: "PENDING",
              task_id: "task-audio-1"
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output: {
              task_id: "task-audio-1",
              task_status: "SUCCEEDED",
              results: [
                {
                  file_url: "https://example.com/interview-audio.mp3",
                  transcription_url: "https://transcription.example.com/result.json",
                  subtask_status: "SUCCEEDED"
                }
              ],
              usage: {
                duration: 12
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transcripts: [
              {
                text: "<|Speech|>主持人：能不能讲一个具体时刻？<|/Speech|>",
                sentences: [
                  { begin_time: 0, end_time: 2800, text: "<|Speech|>主持人：能不能讲一个具体时刻？<|/Speech|>" }
                ]
              },
              {
                text: "<|Speech|>被访者：他们只等我拍板。<|/Speech|>",
                sentences: [{ begin_time: 3000, end_time: 5600, text: "被访者：他们只等我拍板。" }]
              }
            ]
          }),
          { status: 200 }
        )
      );
    const client = createBailianAudioTranscriptionClient({
      apiKey: "test-key",
      fetchImpl,
      pollAttempts: 1,
      pollIntervalMs: 0
    });

    const result = await client.transcribe({
      sourceUrl: "https://example.com/interview-audio.mp3",
      languageHint: "zh"
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
          "X-DashScope-Async": "enable"
        }
      })
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(requestBody).toMatchObject({
      model: "sensevoice-v1",
      input: {
        file_urls: ["https://example.com/interview-audio.mp3"]
      },
      parameters: {
        channel_id: [0],
        disfluency_removal_enabled: true,
        language_hints: ["zh"]
      }
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "https://dashscope.aliyuncs.com/api/v1/tasks/task-audio-1",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json"
        }
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "https://transcription.example.com/result.json", {
      method: "GET"
    });
    expect(result).toEqual({
      providerId: "bailian-sensevoice",
      model: "sensevoice-v1",
      sourceUrl: "https://example.com/interview-audio.mp3",
      taskId: "task-audio-1",
      transcriptionUrl: "https://transcription.example.com/result.json",
      durationSec: 12,
      text: "主持人：能不能讲一个具体时刻？\n被访者：他们只等我拍板。"
    });
  });

  it("uses qwen-plus-character chat completions for interview follow-ups", async () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision", "standard");
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "你说怕失控。我们先落到一个具体项目：如果你不兜底，最坏会发生什么？"
              }
            }
          ]
        }),
        { status: 200 }
      )
    );
    const client = createBailianCharacterInterviewClient({
      apiKey: "test-key",
      fetchImpl
    });

    const result = await client.createAssistantTurn({
      session,
      userText: "我不想每次都替团队兜底，但又怕项目失控。"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json"
        }
      })
    );
    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(requestBody).toMatchObject({
      model: "qwen-plus-character",
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "assistant", content: session.card.suggestedOpening }),
        expect.objectContaining({ role: "user", content: "我不想每次都替团队兜底，但又怕项目失控。" })
      ])
    });
    expect(requestBody.messages[0].content).toContain("真正的专访主持人");
    expect(requestBody.messages[0].content).toContain("<pre_signals>");
    expect(result).toEqual({
      providerId: "bailian-character",
      model: "qwen-plus-character",
      content: "你说怕失控。我们先落到一个具体项目：如果你不兜底，最坏会发生什么？",
      intent: "百炼角色扮演追问"
    });
  });

  it("parses pre_signals from LLM response when present", async () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision");
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: null,
          choices: [{
            message: {
              role: "assistant",
              content: [
                "我们先落到一个具体项目：最坏会发生什么？",
                "",
                "<pre_signals>",
                "depth_direction:",
                "  concept: 团队授权机制",
                "  reason: 用户反复回到兜底与失控的张力",
                "  guidance: 你刚提到的授权机制，能举一个最近的例子吗？",
                "backchannel: 嗯,对,是的,好,我明白",
                "interrupt: 不对,不是,等一下,打断一下",
                "sensitivity: low",
                "</pre_signals>"
              ].join("\n")
            }
          }]
        }),
        { status: 200 }
      )
    );
    const client = createBailianCharacterInterviewClient({
      apiKey: "test-key",
      fetchImpl
    });

    const result = await client.createAssistantTurn({
      session,
      userText: "我不想兜底但又怕失控。"
    });

    expect(result.content).toBe("我们先落到一个具体项目：最坏会发生什么？");
    expect(result.preSignals).toBeDefined();
    expect(result.preSignals!.depthDirection).toEqual({
      concept: "团队授权机制",
      reason: "用户反复回到兜底与失控的张力",
      guidance: "你刚提到的授权机制，能举一个最近的例子吗？",
    });
    expect(result.preSignals!.backchannelWhitelist).toEqual(["嗯", "对", "是的", "好", "我明白"]);
    expect(result.preSignals!.interruptTriggers).toEqual(["不对", "不是", "等一下", "打断一下"]);
    expect(result.preSignals!.interruptSensitivity).toBe("low");
  });

  it("returns no preSignals when LLM response has no pre_signals block", async () => {
    const state = createInitialProductState();
    const session = createSessionDraft(state, "decision");
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: null,
          choices: [{ message: { role: "assistant", content: "我们来聊聊具体项目。" } }]
        }),
        { status: 200 }
      )
    );
    const client = createBailianCharacterInterviewClient({ apiKey: "test-key", fetchImpl });

    const result = await client.createAssistantTurn({
      session,
      userText: "我不想兜底。"
    });

    expect(result.content).toBe("我们来聊聊具体项目。");
    expect(result.preSignals).toBeUndefined();
  });

  it("proxies WebRTC SDP exchange for qwen omni realtime without exposing the API key", async () => {
    const fetchImpl = vi.fn(async () => new Response("answer-sdp", { status: 200 }));
    const client = createBailianRealtimeVoiceClient({
      apiKey: "test-key",
      webrtcEndpoint: "https://realtime-bailian.example.com",
      fetchImpl
    });

    const answerSdp = await client.createWebrtcAnswer({
      model: "qwen3.5-omni-plus-realtime",
      offerSdp: "offer-sdp"
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://realtime-bailian.example.com/api/v1/webrtc/realtime?model=qwen3.5-omni-plus-realtime",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/sdp"
        },
        body: "offer-sdp"
      })
    );
    expect(answerSdp).toBe("answer-sdp");
  });
});
