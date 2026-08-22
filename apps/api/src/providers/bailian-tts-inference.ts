/**
 * One-shot Qwen-Audio TTS over DashScope inference WebSocket.
 * HTTP SpeechSynthesizer is CosyVoice-shaped and returns 400
 * (`[cosyvoice:]Engine error [411]`) for qwen-audio-3.0-tts-plus.
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

export const QWEN_AUDIO_TTS_SAMPLE_RATE = 24000;

export interface InferenceTtsWsLike {
  on(event: "open", handler: () => void): this;
  on(event: "message", handler: (data: Buffer | string, isBinary: boolean) => void): this;
  on(event: "error", handler: (err: Error) => void): this;
  on(event: "close", handler: (code: number, reason: string) => void): this;
  send(data: string): void;
  close(): void;
}

export interface SynthesizeQwenAudioTtsOptions {
  apiKey: string;
  text: string;
  voice: string;
  model: string;
  wsUrl: string;
  sampleRate?: number;
  overallTimeoutMs?: number;
  wsFactory?: (url: string, opts: { headers: Record<string, string> }) => InferenceTtsWsLike;
}

export async function synthesizeQwenAudioTts(
  options: SynthesizeQwenAudioTtsOptions
): Promise<{ wav: Buffer; durationSec: number; voice: string; model: string }> {
  const text = options.text.trim();
  if (!text) {
    throw new Error("TTS text is empty.");
  }
  const sampleRate = options.sampleRate ?? QWEN_AUDIO_TTS_SAMPLE_RATE;
  const overallTimeoutMs = options.overallTimeoutMs ?? 90_000;
  const segments = splitPodcastScript(text);
  const pcm = await collectPcm({ ...options, text, sampleRate, overallTimeoutMs, segments });
  if (pcm.length < 64) {
    throw new Error("TTS returned no audio.");
  }
  return {
    wav: pcmToWav(pcm, sampleRate),
    durationSec: Math.max(1, Math.round(pcm.length / 2 / sampleRate)),
    voice: options.voice,
    model: options.model
  };
}

export function splitPodcastScript(text: string, maxChars = 1500): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];
  const parts: string[] = [];
  let buf = "";
  for (const piece of trimmed.split(/(?<=[。！？\n])/)) {
    if (!piece) continue;
    if (buf && buf.length + piece.length > maxChars) {
      parts.push(buf);
      buf = piece;
    } else {
      buf += piece;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

export function wavToPcm(wav: Buffer): Buffer {
  if (wav.length >= 44 && wav.toString("ascii", 0, 4) === "RIFF") {
    return wav.subarray(44);
  }
  return wav;
}

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function collectPcm(options: SynthesizeQwenAudioTtsOptions & {
  sampleRate: number;
  overallTimeoutMs: number;
  segments: string[];
}): Promise<Buffer> {
  const { apiKey, voice, model, wsUrl, sampleRate, overallTimeoutMs, segments } = options;
  const createWs =
    options.wsFactory ??
    ((url, opts) => new WebSocket(url, opts) as unknown as InferenceTtsWsLike);

  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const taskId = randomUUID();
    const ws = createWs(wsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const timer = setTimeout(() => finish(new Error("TTS timeout")), overallTimeoutMs);

    function finish(err?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    }

    function sendJson(obj: unknown) {
      if (!settled) ws.send(JSON.stringify(obj));
    }

    ws.on("open", () => {
      sendJson({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model,
          parameters: {
            text_type: "PlainText",
            voice,
            format: "pcm",
            sample_rate: sampleRate
          },
          input: {}
        }
      });
    });

    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (settled) return;
      if (isBinary || (Buffer.isBuffer(data) && !isJsonBuffer(data))) {
        chunks.push(Buffer.from(data as Buffer));
        return;
      }
      let msg: { header?: { event?: string; error_message?: string } };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      const event = msg.header?.event;
      if (event === "task-started") {
        for (const segment of segments) {
          sendJson({
            header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
            payload: { input: { text: segment } }
          });
        }
        sendJson({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} }
        });
        return;
      }
      if (event === "task-finished") {
        finish();
        return;
      }
      if (event === "task-failed") {
        finish(new Error(msg.header?.error_message ?? "TTS task-failed"));
      }
    });

    ws.on("error", (err: Error) => finish(err));
    ws.on("close", () => {
      if (!settled) finish(new Error("WebSocket closed unexpectedly"));
    });
  });
}

function isJsonBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const first = buf[0];
  return first === 0x7b || first === 0x5b;
}
