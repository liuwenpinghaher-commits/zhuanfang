import type { FastifyInstance } from "fastify";
import type { AudioRepository } from "../audio-repository";
import type { ProductStateRepository } from "../product-state-repository";
import type { InterviewAudioRole } from "../../../../src/domain/types";

// Read & validate ?role=…;缺省或非法值一律回退 interviewee（向后兼容旧的单路调用）。
function readRole(request: { query?: unknown }): InterviewAudioRole {
  const raw = (request.query as { role?: unknown } | undefined)?.role;
  return raw === "interviewer" ? "interviewer" : "interviewee";
}

export async function registerAudioRoutes(
  server: FastifyInstance,
  audioRepo: AudioRepository,
  productRepo: ProductStateRepository
): Promise<void> {
  server.post("/api/sessions/:id/audio", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    // 审计修复(P2-16/C2):上传不校验会话存在 → 孤儿音频行只有 full purge 能清。按会话存在性拒收。
    const session = productRepo.getInterviewSession(id);
    if (!session) {
      return reply.code(404).send({ error: "Interview session not found." });
    }
    // P3-18:doNotSave 会话在 /end 时整体不落 state(finalize 有意丢弃),其录音本不该留存。
    // 但录音原声是 /end 之前经本端点直传的——存在性校验挡不住(会话此刻仍在)。这里显式拒收,
    // 让"不保存"承诺覆盖最敏感的原声,而不是留下只有 full purge 能清的孤儿原声。
    if (session.doNotSave) {
      return reply.code(422).send({ error: "This session is marked do-not-save; audio uploads are rejected." });
    }
    const role = readRole(request);
    const body = request.body as { audioBase64?: unknown; mime?: unknown; durationMs?: unknown; recordingStartedAt?: unknown } | undefined;
    if (typeof body?.audioBase64 !== "string" || typeof body?.mime !== "string") {
      return reply.code(422).send({ error: "audio requires audioBase64(string) + mime(string)." });
    }
    // 审计修复(F6):mime 白名单——此前存任意 body.mime 并原样回显,可 stored-XSS(上传 text/html
    // 再带 token 直开)。只接受音频类型,非白名单一律降级为 application/octet-stream。
    const ALLOWED_AUDIO_MIME = new Set(["audio/webm", "audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/x-wav", "audio/wave"]);
    const safeMime = ALLOWED_AUDIO_MIME.has(body.mime) ? body.mime : "application/octet-stream";
    const audio = new Uint8Array(Buffer.from(body.audioBase64, "base64"));
    await audioRepo.put({   // R2a:仓库接口已异步化
      sessionId: id,
      role,
      audio,
      mime: safeMime,
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
    const a = await audioRepo.get(id, role);   // R2a:仓库接口已异步化
    if (!a) return reply.code(404).send({ error: "No audio for session." });
    return reply
      .header("content-type", a.mime)
      .header("content-length", String(a.byteSize))
      // 审计修复(F6):防浏览器嗅探/内联渲染回显字节。
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", "attachment")
      .send(Buffer.from(a.audio));
  });

  server.get("/api/sessions/:id/audio/meta", async (request) => {
    const id = (request.params as { id?: string }).id ?? "";
    const role = readRole(request);
    const a = await audioRepo.get(id, role);   // R2a:仓库接口已异步化
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
