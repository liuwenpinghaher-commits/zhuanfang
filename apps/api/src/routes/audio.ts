import type { FastifyInstance } from "fastify";
import type { AudioRepository } from "../audio-repository";

export async function registerAudioRoutes(server: FastifyInstance, audioRepo: AudioRepository): Promise<void> {
  server.post("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const body = request.body as { audioBase64?: unknown; mime?: unknown; durationMs?: unknown } | undefined;
    if (typeof body?.audioBase64 !== "string" || typeof body?.mime !== "string") {
      return reply.code(422).send({ error: "audio requires audioBase64(string) + mime(string)." });
    }
    const audio = new Uint8Array(Buffer.from(body.audioBase64, "base64"));
    audioRepo.put({
      sessionId: id,
      audio,
      mime: body.mime,
      byteSize: audio.byteLength,
      ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
      createdAt: new Date().toISOString()
    });
    return { ok: true, byteSize: audio.byteLength };
  });

  server.get("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const a = audioRepo.get(id);
    if (!a) return reply.code(404).send({ error: "No audio for session." });
    return reply
      .header("content-type", a.mime)
      .header("content-length", String(a.byteSize))
      .send(Buffer.from(a.audio));
  });

  server.get("/api/sessions/:id/audio/meta", async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const a = audioRepo.get(id);
    return a
      ? { exists: true, mime: a.mime, byteSize: a.byteSize, durationMs: a.durationMs ?? null }
      : { exists: false };
  });
}
