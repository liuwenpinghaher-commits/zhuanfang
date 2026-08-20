/**
 * Eval copy of tests/e2e/fakeMic install+speak (no Playwright test helpers).
 * Injects a synthetic getUserMedia stream; speak() plays 16k s16le PCM.
 */
export async function installFakeMic(context) {
  await context.grantPermissions(["microphone"]);
  await context.addInitScript(() => {
    const SR = 16000;
    const w = window;
    if (w.__fakeMic) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate: SR });
    const dest = ctx.createMediaStreamDestination();
    w.__fakeMic = {
      play(pcmB64) {
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
        return new Promise((resolve) => {
          src.onended = () => resolve((f32.length / SR) * 1000);
          ctx
            .resume()
            .catch(() => {})
            .finally(() => src.start());
        });
      }
    };
    const md = navigator.mediaDevices || (navigator.mediaDevices = {});
    md.getUserMedia = async () => dest.stream;
  });
}

export async function speak(page, pcmBase64, opts = {}) {
  await page.evaluate((b64) => window.__fakeMic.play(b64), pcmBase64);
  await page.waitForTimeout(opts.vadSilenceMs ?? 1700);
}
