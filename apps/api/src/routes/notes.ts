import type { FastifyInstance } from "fastify";
import {
  DELETE_SESSION_NOTE_CONFIRM,
  forgetSessionNote,
  type ForgetSessionNoteReceipt
} from "../../../../src/domain/lifecycle";
import type { KnowledgeSourceType } from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";
import type { RawMaterialRepository } from "../raw-material-repository";
import type { AudioRepository } from "../audio-repository";
import type { KnowledgeIndexRepository } from "../knowledge-index-repository";
import { deletePodcastAudio } from "../podcast-audio-store";
import { runStateCommand } from "../state-command";
import type { WriteGate } from "../server";

export interface ForgetColdReceipt {
  audio: "cleared" | "failed";
  rawMaterial: "cleared" | "failed";
  knowledge: "cleared" | "failed";
  podcastAudio: { deleted: number; failed: number; missing: number };
}

interface NotesRouteOptions {
  writeGate?: WriteGate;
  rawMaterialRepository?: RawMaterialRepository;
  audioRepository?: AudioRepository;
  knowledgeIndexRepository?: KnowledgeIndexRepository;
}

export async function registerNotesRoutes(
  server: FastifyInstance,
  repository: ProductStateRepository,
  options: NotesRouteOptions = {}
) {
  server.post("/api/notes/:id/forget", async (request, reply) => {
    const noteId = getRouteId(request.params);
    if (!noteId) {
      return reply.code(400).send({ error: "缺少笔记编号。" });
    }
    const body = normalizeObject<{
      confirm?: unknown;
      exclusiveAssets?: unknown;
      confirmedMemory?: unknown;
    }>(request.body);
    if (body.confirm !== DELETE_SESSION_NOTE_CONFIRM) {
      return reply.code(422).send({ error: "删除一场笔记需要二次确认。" });
    }

    let failure: { code: number; error: string } | null = null;
    let receipt: ForgetSessionNoteReceipt | undefined;
    const persisted = await runStateCommand(
      repository,
      (state) => {
        failure = null;
        receipt = undefined;
        const result = forgetSessionNote(state, noteId, {
          exclusiveAssets: body.exclusiveAssets === true,
          confirmedMemory: body.confirmedMemory === true
        });
        if (!result) {
          failure = { code: 404, error: "这篇笔记不在了。" };
          return null;
        }
        receipt = result.receipt;
        return result.nextState;
      },
      { writeGate: options.writeGate, label: `command:note-forget:${noteId}` }
    );

    if (!persisted || !receipt) {
      const f = failure ?? { code: 500, error: "这场没能拿走。" };
      return reply.code(f.code).send({ error: f.error });
    }

    const cold = await clearSessionColdLayer(receipt, options);
    return {
      state: persisted,
      receipt: {
        ...receipt,
        cold,
        partialColdFailure: isPartialColdFailure(cold)
      }
    };
  });
}

function isPartialColdFailure(cold: ForgetColdReceipt): boolean {
  return (
    cold.audio === "failed" ||
    cold.rawMaterial === "failed" ||
    cold.knowledge === "failed" ||
    cold.podcastAudio.failed > 0
  );
}

async function clearSessionColdLayer(
  receipt: ForgetSessionNoteReceipt,
  options: NotesRouteOptions
): Promise<ForgetColdReceipt> {
  const cold: ForgetColdReceipt = {
    audio: "cleared",
    rawMaterial: "cleared",
    knowledge: "cleared",
    podcastAudio: { deleted: 0, failed: 0, missing: 0 }
  };

  if (receipt.removed.session && options.audioRepository) {
    try {
      await options.audioRepository.delete(receipt.sessionId);
    } catch (err) {
      cold.audio = "failed";
      logColdFailure("audio", receipt, err);
    }
  }

  if (receipt.removed.session && options.rawMaterialRepository) {
    try {
      await options.rawMaterialRepository.delete(receipt.sessionId);
    } catch (err) {
      cold.rawMaterial = "failed";
      logColdFailure("raw-material", receipt, err);
    }
  }

  if (options.knowledgeIndexRepository) {
    try {
      await deleteKnowledgeForForgottenNote(options.knowledgeIndexRepository, receipt);
    } catch (err) {
      cold.knowledge = "failed";
      logColdFailure("knowledge", receipt, err);
    }
  }

  for (const episodeId of receipt.removedIds.podcasts) {
    try {
      const outcome = await deletePodcastAudio(episodeId);
      if (outcome === "deleted") cold.podcastAudio.deleted += 1;
      else cold.podcastAudio.missing += 1;
    } catch (err) {
      cold.podcastAudio.failed += 1;
      logColdFailure("podcast-audio", receipt, err, episodeId);
    }
  }

  return cold;
}

async function deleteKnowledgeForForgottenNote(
  knowledgeRepo: KnowledgeIndexRepository,
  receipt: ForgetSessionNoteReceipt
) {
  await knowledgeRepo.deleteBySource("note", receipt.noteId);
  const deleted: Array<{ type: KnowledgeSourceType; id: string }> = [
    ...receipt.removedIds.points.map((id) => ({ type: "point" as const, id })),
    ...receipt.removedIds.decisions.map((id) => ({ type: "decision" as const, id })),
    ...receipt.removedIds.debts.map((id) => ({ type: "debt" as const, id })),
    ...receipt.removedIds.memories.map((id) => ({ type: "memory" as const, id }))
  ];
  for (const item of deleted) {
    await knowledgeRepo.deleteBySource(item.type, item.id);
  }
  if (!receipt.removed.session) return;
  for (const chunk of await knowledgeRepo.listAll()) {
    if (chunk.sourceType !== "transcript") continue;
    const sid = chunk.sourceId.split("#")[0];
    if (sid === receipt.sessionId) {
      await knowledgeRepo.deleteBySource("transcript", chunk.sourceId);
    }
  }
}

function logColdFailure(
  store: string,
  receipt: ForgetSessionNoteReceipt,
  err: unknown,
  extraId?: string
) {
  console.warn(JSON.stringify({
    event: "note_forget_cold_failed",
    store,
    noteId: receipt.noteId,
    sessionId: receipt.sessionId,
    extraId,
    error: err instanceof Error ? err.message : String(err)
  }));
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getRouteId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}
