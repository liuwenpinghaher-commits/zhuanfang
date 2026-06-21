import type { FastifyInstance } from "fastify";
import type { AudioRepository } from "../audio-repository";
import type { InterviewAudioRole } from "../../../../src/domain/types";

// Read & validate ?role=…;缺省或非法值一律回退 interviewee（向后兼容旧的单路调用）。
function readRole(request: { query?: unknown }): InterviewAudioRole {
  const raw = (request.query as { role?: unknown } | undefined)?.role;
  return raw === "interviewer" ? "interviewer" : "interviewee";
}

export async function registerAudioRoutes(server: FastifyInstance, audioRepo: AudioRepository): Promise<void> {
  server.post("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const role = readRole(request);
    const body = request.body as { audioBase64?: unknown; mime?: unknown; durationMs?: unknown; recordingStartedAt?: unknown } | undefined;
    if (typeof body?.audioBase64 !== "string" || typeof body?.mime !== "string") {
      return reply.code(422).send({ error: "audio requires audioBase64(string) + mime(string)." });
    }
    const audio = new Uint8Array(Buffer.from(body.audioBase64, "base64"));
    audioRepo.put({
      sessionId: id,
      role,
      audio,
      mime: body.mime,
      byteSize: audio.byteLength,
      ...(typeof body.durationMs === "number" ? { durationMs: body.durationMs } : {}),
      ...(typeof body.recordingStartedAt === "string" ? { recordingStartedAt: body.recordingStartedAt } : {}),
      createdAt: new Date().toISOString()
    });
    return { ok: true, byteSize: audio.byteLength };
  });

  server.get("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    const role = readRole(request);
    const a = audioRepo.get(id, role);
    if (!a) return reply.code(404).send({ error: "No audio for session." });
    return reply
      .header("content-type", a.mime)
      .header("content-length", String(a.byteSize))
      .send(Buffer.from(a.audio));
  });

  server.get("/api/sessions/:id/audio/meta", async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const role = readRole(request);
    const a = audioRepo.get(id, role);
    return a
      ? {
          exists: true,
          role: a.role,
          mime: a.mime,
          byteSize: a.byteSize,
          durationMs: a.durationMs ?? null,
          recordingStartedAt: a.recordingStartedAt ?? null
        }
      : { exists: false };
  });
}
