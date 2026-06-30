// 办法 B:注入合成 MediaStream 当麦克风。覆盖 navigator.mediaDevices.getUserMedia,返回一个由
// Web Audio MediaStreamDestination 驱动的 16kHz 单声道流(与 cascadedAsrSource 的
// AudioContext({sampleRate:16000}) 对齐),测试用 speak() 按需 push 一段 TTS 生成的 PCM「说话」。
// 完整过真实 AudioContext→ScriptProcessor→WebSocket→DashScope ASR,但时序由测试掌控(说一轮→
// 等主持人回应→说下一轮),避开「假音频文件固定时间轴对不齐多轮交互」的根本缺陷。
//
// fixture 由 scripts/gen-voice-fixtures.mjs 用项目自己的 CosyVoice TTS 预生成(16k mono s16le base64)。
import type { BrowserContext, Page } from "@playwright/test";

/** 在页面加载前注入假麦克风。对整个 context 生效,后续每个 page 都用同一套合成图。 */
export async function installFakeMic(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["microphone"]);
  await context.addInitScript(() => {
    const SR = 16000;
    const w = window as unknown as { __fakeMic?: { play(b64: string): Promise<number> } };
    if (w.__fakeMic) return;
    const Ctx: typeof AudioContext = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    const ctx = new Ctx({ sampleRate: SR });
    const dest = ctx.createMediaStreamDestination();
    // 不 push 音频时 dest 输出静音 → cascadedAsrSource 的 server_vad 据此断句。
    w.__fakeMic = {
      // 播放一段 s16le PCM(base64),resolve 返回播放时长 ms。
      play(pcmB64: string): Promise<number> {
        const bin = atob(pcmB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
        const f32 = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
        const buf = ctx.createBuffer(1, f32.length, SR);
        buf.copyToChannel(f32, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(dest);
        return new Promise<number>((resolve) => {
          src.onended = () => resolve((f32.length / SR) * 1000);
          // autoplay 限制下 AudioContext 可能 suspended,强制 resume 再播。
          ctx.resume().catch(() => {}).finally(() => src.start());
        });
      }
    };
    const fakeGUM = async (): Promise<MediaStream> => dest.stream;
    const md = navigator.mediaDevices ?? ((navigator as unknown as { mediaDevices: MediaDevices }).mediaDevices = {} as MediaDevices);
    md.getUserMedia = fakeGUM as MediaDevices["getUserMedia"];
  });
}

/** 说一轮:播放 PCM,再等够 VAD 静音窗(默认 1700ms > server_vad silence_duration_ms 1500)让 ASR 断句出 turn。 */
export async function speak(page: Page, pcmBase64: string, opts: { vadSilenceMs?: number } = {}): Promise<void> {
  await page.evaluate((b64) => (window as unknown as { __fakeMic: { play(b: string): Promise<number> } }).__fakeMic.play(b64), pcmBase64);
  await page.waitForTimeout(opts.vadSilenceMs ?? 1700);
}

export interface VoiceFixture {
  sampleRate: number;
  channels: number;
  format: string;
  utterances: Array<{ text: string; pcmBase64: string; durationMs: number }>;
}

/** 跑一整场语音访谈:逐轮 speak,每轮之间用 waitForReply 等主持人回应(如等 voiceStatus 回 listening / 新 turn 出现)。 */
export async function speakSession(
  page: Page,
  fixture: VoiceFixture,
  waitForReply?: (page: Page, roundIndex: number) => Promise<void>
): Promise<void> {
  for (let i = 0; i < fixture.utterances.length; i++) {
    await speak(page, fixture.utterances[i].pcmBase64);
    if (waitForReply) await waitForReply(page, i);
  }
}
