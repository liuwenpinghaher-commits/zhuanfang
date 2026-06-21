import { describe, it, expect } from "vitest";
import { pcmS16leMonoToWav, buildWavHeader } from "./pcmWav";

/** Read a little-endian uint32 from a DataView. */
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** Read a little-endian uint16 from a DataView. */
function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

/** Read a 4-byte ASCII tag (byte order as written in the file). */
function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

describe("pcmS16leMonoToWav", () => {
  it("produces a Blob of size 44 + pcm.length with audio/wav type", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); // 4 samples
    const blob = pcmS16leMonoToWav(pcm, 24000);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + pcm.length);
  });

  it("empty PCM still yields a valid 44-byte header Blob", () => {
    const blob = pcmS16leMonoToWav(new Uint8Array(0), 24000);
    expect(blob.size).toBe(44);
    expect(blob.type).toBe("audio/wav");
  });
});

describe("buildWavHeader", () => {
  // The header is validated directly on the returned Uint8Array (pure, Blob-free):
  // jsdom's Blob byte readback is unreliable, so we assert the bytes here instead.
  it("is exactly 44 bytes", () => {
    expect(buildWavHeader(6, 16000).length).toBe(44);
  });

  it("writes a correct WAV header for the given data size and sample rate", () => {
    const dataSize = 6; // 3 samples
    const sampleRate = 16000;
    const header = buildWavHeader(dataSize, sampleRate);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);

    // RIFF chunk descriptor.
    expect(tag(view, 0)).toBe("RIFF");
    expect(u32(view, 4)).toBe(36 + dataSize); // ChunkSize = 36 + Subchunk2Size
    expect(tag(view, 8)).toBe("WAVE");

    // fmt subchunk.
    expect(tag(view, 12)).toBe("fmt ");
    expect(u32(view, 16)).toBe(16); // Subchunk1Size for PCM
    expect(u16(view, 20)).toBe(1); // AudioFormat = PCM
    expect(u16(view, 22)).toBe(1); // NumChannels = mono
    expect(u32(view, 24)).toBe(sampleRate); // SampleRate (little-endian)
    expect(u32(view, 28)).toBe(sampleRate * 2); // ByteRate = sampleRate * channels * bytesPerSample
    expect(u16(view, 32)).toBe(2); // BlockAlign = channels * bytesPerSample
    expect(u16(view, 34)).toBe(16); // BitsPerSample

    // data subchunk.
    expect(tag(view, 36)).toBe("data");
    expect(u32(view, 40)).toBe(dataSize); // Subchunk2Size = byte count of PCM
  });

  it("encodes sample rate little-endian (24000 = 0xC0 0x5D 0x00 0x00)", () => {
    const header = buildWavHeader(0, 24000);
    expect(Array.from(header.slice(24, 28))).toEqual([0xc0, 0x5d, 0x00, 0x00]);
  });
});
