import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createEmptyProductState } from "../../../../src/domain/engine";
import { DELETE_SESSION_NOTE_CONFIRM } from "../../../../src/domain/lifecycle";
import type { DualTrackNote, InterviewSession, PointAsset, ProductState } from "../../../../src/domain/types";
import { createInMemoryProductStateRepository } from "../product-state-repository";
import { createInMemoryAudioRepository } from "../audio-repository";
import { createInMemoryRawMaterialRepository } from "../raw-material-repository";
import { createInMemoryKnowledgeIndexRepository } from "../knowledge-index-repository";
import { registerNotesRoutes } from "./notes";

function session(id: string): InterviewSession {
  return {
    id,
    mode: "daily",
    strength: "standard",
    status: "completed",
    title: "场",
    card: {
      title: "t",
      whyNow: "w",
      suggestedOpening: "o",
      historyReferences: [],
      potentialTension: "p",
      suggestedPerspectives: [],
      likelyOutputs: []
    },
    guide: {
      topicHint: "x",
      dailyBrief: { suggestedTopic: "x", openingQuestion: "o", contextNote: "c" },
      perspectiveCoverage: {},
      missingPerspectives: [],
      recommendedPerspectives: [],
      perspectiveRationale: "",
      relevantMemories: [],
      graphReferences: [],
      opinionEvolution: [],
      statedPositions: [],
      openDebts: [],
      decisionsToReview: [],
      blindspotCandidates: [],
      knowledgeFragments: [],
      suggestedOpening: "o",
      strategyChecklist: []
    },
    turns: [],
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T01:00:00.000Z"
  };
}

function note(id: string, sessionId: string): DualTrackNote {
  return {
    id,
    sessionId,
    title: `笔记-${id}`,
    summary: "摘要",
    keyQuote: "原话",
    saidTrack: ["我说"],
    learnedTrack: ["学到"],
    nextQuestions: [],
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

function point(id: string, extra: Partial<PointAsset> = {}): PointAsset {
  return {
    id,
    title: `观点-${id}`,
    content: "内容",
    status: "稳定观点",
    confidence: "AI 推断",
    evidence: [],
    important: false,
    updatedAt: "2026-08-01T00:00:00.000Z",
    sourceSessionId: extra.sourceSessionId ?? "s1",
    ...extra
  };
}

function seededState(): ProductState {
  return {
    ...createEmptyProductState(),
    notes: [note("n1", "s1"), note("n2", "s2")],
    sessions: [session("s1"), session("s2")],
    points: [
      point("p-only", { sourceSessionId: "s1" }),
      point("p-shared", { sourceSessionId: "s1", appearedInSessionIds: ["s1", "s2"] })
    ]
  };
}

describe("POST /api/notes/:id/forget", () => {
  const stateRepo = createInMemoryProductStateRepository(seededState());
  const audioRepo = createInMemoryAudioRepository();
  const rawRepo = createInMemoryRawMaterialRepository();
  const knowledgeRepo = createInMemoryKnowledgeIndexRepository();
  const app = Fastify();

  beforeAll(async () => {
    await audioRepo.put({
      sessionId: "s1",
      role: "interviewee",
      audio: new Uint8Array([1, 2, 3]),
      mime: "audio/webm",
      byteSize: 3,
      durationMs: 1000,
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await audioRepo.put({
      sessionId: "s1",
      role: "interviewer",
      audio: new Uint8Array([4, 5]),
      mime: "audio/webm",
      byteSize: 2,
      durationMs: 800,
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await rawRepo.put({
      sessionId: "s1",
      turns: [],
      strategyTrace: [],
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await knowledgeRepo.put({
      id: "k-note",
      sourceType: "note",
      sourceId: "n1",
      title: "笔记块",
      text: "正文",
      keywords: [],
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await knowledgeRepo.put({
      id: "k-tr",
      sourceType: "transcript",
      sourceId: "s1#t1",
      title: "逐字",
      text: "我说",
      keywords: [],
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await knowledgeRepo.put({
      id: "k-keep",
      sourceType: "note",
      sourceId: "n2",
      title: "别的笔记",
      text: "留下",
      keywords: [],
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await registerNotesRoutes(app, stateRepo, {
      audioRepository: audioRepo,
      rawMaterialRepository: rawRepo,
      knowledgeIndexRepository: knowledgeRepo
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects without confirm", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notes/n1/forget",
      payload: {}
    });
    expect(res.statusCode).toBe(422);
    expect(stateRepo.getState().notes.map((item) => item.id)).toEqual(["n1", "n2"]);
  });

  it("returns 404 for a missing note", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notes/missing/forget",
      payload: { confirm: DELETE_SESSION_NOTE_CONFIRM }
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes the note, session audio, transcript, and keeps merged points", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/notes/n1/forget",
      payload: { confirm: DELETE_SESSION_NOTE_CONFIRM }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: ProductState; receipt: { removed: { session: boolean }; keptShared: { points: number }; cold: { audio: string } } };
    expect(body.state.notes.map((item) => item.id)).toEqual(["n2"]);
    expect(body.state.sessions.map((item) => item.id)).toEqual(["s2"]);
    expect(body.state.points.map((item) => item.id).sort()).toEqual(["p-only", "p-shared"]);
    expect(body.receipt.keptShared.points).toBe(2);
    expect(body.receipt.cold.audio).toBe("cleared");
    expect(await audioRepo.has("s1", "interviewee")).toBe(false);
    expect(await audioRepo.has("s1", "interviewer")).toBe(false);
    expect(await rawRepo.get("s1")).toBeUndefined();
    const chunks = await knowledgeRepo.listAll();
    expect(chunks.map((c) => c.id)).toEqual(["k-keep"]);
  });
});

describe("POST /api/notes/:id/forget exclusiveAssets", () => {
  it("deletes session-only points and keeps merged ones", async () => {
    const stateRepo = createInMemoryProductStateRepository({
      ...createEmptyProductState(),
      notes: [note("n1", "s1"), note("n2", "s2")],
      sessions: [session("s1"), session("s2")],
      points: [
        point("p-only", { sourceSessionId: "s1" }),
        point("p-shared", { sourceSessionId: "s1", appearedInSessionIds: ["s1", "s2"] })
      ]
    });
    const app = Fastify();
    await registerNotesRoutes(app, stateRepo);
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/notes/n1/forget",
      payload: { confirm: DELETE_SESSION_NOTE_CONFIRM, exclusiveAssets: true }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: ProductState };
    expect(body.state.points.map((item) => item.id)).toEqual(["p-shared"]);
    expect(body.state.points[0].appearedInSessionIds).toEqual(["s2"]);
    await app.close();
  });
});
