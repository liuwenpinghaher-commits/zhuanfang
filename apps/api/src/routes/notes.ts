import type { FastifyInstance } from "fastify";
import { createQuestionFromNote, submitInterviewFeedback } from "../../../../src/domain/engine";
import type {
  DualTrackNote,
  InterviewFeedbackInput,
  InterviewFeedbackTag,
  ProductState,
  QuestionAsset
} from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

interface CreateQuestionFromNotePayload {
  nextQuestionIndex?: unknown;
}

interface SubmitNoteFeedbackPayload {
  tags?: unknown;
  mostValuableQuestion?: unknown;
  inaccurateSummary?: unknown;
  uncomfortableButImportant?: unknown;
  newUnderstanding?: unknown;
  continuePrompt?: unknown;
}

const feedbackTags: InterviewFeedbackTag[] = [
  "went-deep",
  "off-track",
  "too-gentle",
  "too-strong",
  "memory-wrong",
  "summary-accurate",
  "continue-next"
];

export async function registerNoteRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.post("/api/notes/:id/questions", async (request, reply) => {
    const state = repository.getState();
    const note = findNote(state, getRouteId(request.params));
    if (!note) {
      return reply.code(404).send({ error: "Note not found." });
    }

    const payload = normalizeObject<CreateQuestionFromNotePayload>(request.body);
    const nextQuestionIndex = normalizeQuestionIndex(payload.nextQuestionIndex);
    if (nextQuestionIndex === undefined || !note.nextQuestions[nextQuestionIndex]) {
      return reply.code(422).send({ error: "A valid note follow-up question index is required." });
    }

    const nextState = createQuestionFromNote(state, note.id, nextQuestionIndex);
    const question = findCreatedQuestion(nextState, note.nextQuestions[nextQuestionIndex]);
    if (!question) {
      return reply.code(500).send({ error: "Note follow-up question was not created." });
    }
    repository.replaceState(nextState);

    return { question, state: nextState };
  });

  server.post("/api/notes/:id/feedback", async (request, reply) => {
    const state = repository.getState();
    const note = findNote(state, getRouteId(request.params));
    if (!note) {
      return reply.code(404).send({ error: "Note not found." });
    }

    const nextState = submitInterviewFeedback(state, note.id, normalizeFeedbackInput(request.body));
    const updatedNote = findNote(nextState, note.id);
    if (!updatedNote) {
      return reply.code(500).send({ error: "Note feedback was not created." });
    }
    repository.replaceState(nextState);

    return { note: updatedNote, state: nextState };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getRouteId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function normalizeQuestionIndex(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeFeedbackInput(value: unknown): InterviewFeedbackInput {
  const payload = normalizeObject<SubmitNoteFeedbackPayload>(value);
  return {
    tags: normalizeFeedbackTags(payload.tags),
    mostValuableQuestion: normalizeOptionalString(payload.mostValuableQuestion),
    inaccurateSummary: normalizeOptionalString(payload.inaccurateSummary),
    uncomfortableButImportant: normalizeOptionalString(payload.uncomfortableButImportant),
    newUnderstanding: normalizeOptionalString(payload.newUnderstanding),
    continuePrompt: normalizeOptionalString(payload.continuePrompt)
  };
}

function normalizeFeedbackTags(value: unknown): InterviewFeedbackTag[] {
  return Array.isArray(value)
    ? value.filter((tag): tag is InterviewFeedbackTag => typeof tag === "string" && feedbackTags.includes(tag as InterviewFeedbackTag))
    : [];
}

function normalizeOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findNote(state: ProductState, noteId: unknown): DualTrackNote | undefined {
  return typeof noteId === "string" ? state.notes.find((note) => note.id === noteId) : undefined;
}

function findCreatedQuestion(state: ProductState, questionText: string): QuestionAsset | undefined {
  return state.questions.find((question) => question.question === questionText && question.id.startsWith("question-from-note"));
}
