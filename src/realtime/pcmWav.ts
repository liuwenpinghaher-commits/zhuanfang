/**
 * Wrap raw PCM (signed 16-bit little-endian, mono) in a minimal 44-byte WAV
 * header so it can be stored / streamed as a playable file.
 *
 * Used for the interviewer (host) TTS audio: the cascade sink receives audio as
 * a stream of raw PCM chunks (s16le, mono) and plays them straight away with no
 * container. To persist the concatenated stream we prepend a canonical PCM WAV
 * header — the only fields that vary are the sample rate and the byte length.
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1; // mono
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

/** Write a 4-char ASCII tag into the DataView at the given offset. */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i++) {
    view.setUint8(offset + i, tag.charCodeAt(i));
  }
}

/**
 * Build the canonical 44-byte PCM WAV header for a mono s16le stream.
 *
 * Pure + Blob-free so it is directly unit-testable (jsdom's Blob byte readback
 * is unreliable, so we validate header bytes on this Uint8Array instead).
 *
 * @param dataSize   Byte length of the PCM payload that will follow the header.
 * @param sampleRate Sample rate the PCM was captured at (Hz).
 */
export function buildWavHeader(dataSize: number, sampleRate: number): Uint8Array {
  const byteRate = sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;

  const header = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(header);

  // RIFF chunk descriptor.
  writeTag(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // ChunkSize = 4 + (8 + 16) + (8 + dataSize)
  writeTag(view, 8, "WAVE");

  // fmt subchunk.
  writeTag(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // data subchunk.
  writeTag(view, 36, "data");
  view.setUint32(40, dataSize, true);

  return new Uint8Array(header);
}

/**
 * Build a WAV Blob from raw PCM (s16le, mono).
 *
 * @param pcm        Raw PCM bytes (signed 16-bit LE, mono). Length should be
 *                   even; an odd trailing byte is still included as-is.
 * @param sampleRate Sample rate the PCM was captured at (Hz).
 * @returns A `audio/wav` Blob: 44-byte header followed by the PCM bytes.
 */
export function pcmS16leMonoToWav(pcm: Uint8Array, sampleRate: number): Blob {
  const header = buildWavHeader(pcm.length, sampleRate);
  // Concatenate into one fresh ArrayBuffer-backed Uint8Array. Besides being a
  // single Blob part, this sidesteps TS5.7's BlobPart typing, which rejects a
  // generic Uint8Array<ArrayBufferLike> (the incoming `pcm` may be SharedArrayBuffer-backed).
  const out = new Uint8Array(header.length + pcm.length);
  out.set(header, 0);
  out.set(pcm, header.length);
  return new Blob([out], { type: "audio/wav" });
}
