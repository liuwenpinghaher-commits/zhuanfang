import type { FastifyInstance } from "fastify";
import {
  confirmDecisionCandidate,
  toggleAssetImportance,
  updateDecisionStatus,
  updateKnowledgeDebtStatus,
  updatePointStatus,
  updateQuestionStatus,
} from "../../../../src/domain/engine";
import type {
  AssetStatus,
  DecisionAsset,
  KnowledgeDebt,
  PointAsset,
  ProductState,
  QuestionAsset,
} from "../../../../src/domain/types";
import type { ProductStateRepository } from "../product-state-repository";

interface UpdateAssetStatusPayload {
  status?: unknown;
}

type PointStatus = Extract<AssetStatus, "临时想法" | "稳定观点" | "被挑战中" | "已修正" | "已放弃">;
type QuestionStatus = Extract<AssetStatus, "开放" | "反复出现" | "正在聚焦" | "阶段性回答">;
type DebtStatus = Extract<AssetStatus, "待了解" | "能复述" | "已应用" | "不相关">;

const pointStatuses: PointStatus[] = ["临时想法", "稳定观点", "被挑战中", "已修正", "已放弃"];
const questionStatuses: QuestionStatus[] = ["开放", "反复出现", "正在聚焦", "阶段性回答"];
const debtStatuses: DebtStatus[] = ["待了解", "能复述", "已应用", "不相关"];
const decisionStatuses: DecisionAsset["status"][] = ["待复盘", "已复盘"];

export async function registerAssetRoutes(server: FastifyInstance, repository: ProductStateRepository) {
  server.patch("/api/assets/points/:id/status", async (request, reply) => {
    const state = repository.getState();
    const pointId = getRouteId(request.params);
    const point = findPoint(state, pointId);
    if (!point) {
      return reply.code(404).send({ error: "Point asset not found." });
    }

    const status = normalizePointStatus(normalizeObject<UpdateAssetStatusPayload>(request.body).status);
    if (!status) {
      return reply.code(422).send({ error: "A valid point asset status is required." });
    }

    const nextState = updatePointStatus(state, point.id, status);
    const updatedPoint = findPoint(nextState, point.id);
    if (!updatedPoint) {
      return reply.code(500).send({ error: "Point asset status was not updated." });
    }

    repository.replaceState(nextState);
    return { asset: updatedPoint, state: nextState };
  });

  server.patch("/api/assets/questions/:id/status", async (request, reply) => {
    const state = repository.getState();
    const questionId = getRouteId(request.params);
    const question = findQuestion(state, questionId);
    if (!question) {
      return reply.code(404).send({ error: "Question asset not found." });
    }

    const status = normalizeQuestionStatus(normalizeObject<UpdateAssetStatusPayload>(request.body).status);
    if (!status) {
      return reply.code(422).send({ error: "A valid question asset status is required." });
    }

    const nextState = updateQuestionStatus(state, question.id, status);
    const updatedQuestion = findQuestion(nextState, question.id);
    if (!updatedQuestion) {
      return reply.code(500).send({ error: "Question asset status was not updated." });
    }

    repository.replaceState(nextState);
    return { asset: updatedQuestion, state: nextState };
  });

  server.patch("/api/assets/debts/:id/status", async (request, reply) => {
    const state = repository.getState();
    const debtId = getRouteId(request.params);
    const debt = findDebt(state, debtId);
    if (!debt) {
      return reply.code(404).send({ error: "Knowledge debt asset not found." });
    }

    const status = normalizeDebtStatus(normalizeObject<UpdateAssetStatusPayload>(request.body).status);
    if (!status) {
      return reply.code(422).send({ error: "A valid knowledge debt status is required." });
    }

    const nextState = updateKnowledgeDebtStatus(state, debt.id, status);
    const updatedDebt = findDebt(nextState, debt.id);
    if (!updatedDebt) {
      return reply.code(500).send({ error: "Knowledge debt status was not updated." });
    }

    repository.replaceState(nextState);
    return { asset: updatedDebt, state: nextState };
  });

  server.post("/api/assets/decisions/:id/confirm", async (request, reply) => {
    const state = repository.getState();
    const decisionId = getRouteId(request.params);
    const decision = findDecision(state, decisionId);
    if (!decision) {
      return reply.code(404).send({ error: "Decision asset not found." });
    }
    if (decision.confirmationStatus !== "待用户确认") {
      return reply.code(409).send({ error: "Decision asset is already confirmed." });
    }

    const nextState = confirmDecisionCandidate(state, decision.id);
    const updatedDecision = findDecision(nextState, decision.id);
    if (!updatedDecision || updatedDecision.confirmationStatus !== "用户确认") {
      return reply.code(500).send({ error: "Decision asset was not confirmed." });
    }

    repository.replaceState(nextState);
    return { asset: updatedDecision, state: nextState };
  });

  server.patch("/api/assets/decisions/:id/status", async (request, reply) => {
    const state = repository.getState();
    const decisionId = getRouteId(request.params);
    const decision = findDecision(state, decisionId);
    if (!decision) {
      return reply.code(404).send({ error: "Decision asset not found." });
    }

    const status = normalizeDecisionStatus(normalizeObject<UpdateAssetStatusPayload>(request.body).status);
    if (!status) {
      return reply.code(422).send({ error: "A valid decision review status is required." });
    }

    const nextState = updateDecisionStatus(state, decision.id, status);
    const updatedDecision = findDecision(nextState, decision.id);
    if (!updatedDecision) {
      return reply.code(500).send({ error: "Decision review status was not updated." });
    }

    repository.replaceState(nextState);
    return { asset: updatedDecision, state: nextState };
  });
}

function normalizeObject<T>(value: unknown): Partial<T> {
  return value && typeof value === "object" ? (value as Partial<T>) : {};
}

function getRouteId(params: unknown) {
  return normalizeObject<{ id: string }>(params).id;
}

function normalizePointStatus(value: unknown): PointStatus | undefined {
  return typeof value === "string" && pointStatuses.includes(value as PointStatus) ? (value as PointStatus) : undefined;
}

function normalizeQuestionStatus(value: unknown): QuestionStatus | undefined {
  return typeof value === "string" && questionStatuses.includes(value as QuestionStatus)
    ? (value as QuestionStatus)
    : undefined;
}

function normalizeDebtStatus(value: unknown): DebtStatus | undefined {
  return typeof value === "string" && debtStatuses.includes(value as DebtStatus) ? (value as DebtStatus) : undefined;
}

function normalizeDecisionStatus(value: unknown): DecisionAsset["status"] | undefined {
  return typeof value === "string" && decisionStatuses.includes(value as DecisionAsset["status"])
    ? (value as DecisionAsset["status"])
    : undefined;
}

function findPoint(state: ProductState, pointId: unknown): PointAsset | undefined {
  return typeof pointId === "string" ? state.points.find((point) => point.id === pointId) : undefined;
}

function findQuestion(state: ProductState, questionId: unknown): QuestionAsset | undefined {
  return typeof questionId === "string" ? state.questions.find((question) => question.id === questionId) : undefined;
}

function findDebt(state: ProductState, debtId: unknown): KnowledgeDebt | undefined {
  return typeof debtId === "string" ? state.debts.find((debt) => debt.id === debtId) : undefined;
}

function findDecision(state: ProductState, decisionId: unknown): DecisionAsset | undefined {
  return typeof decisionId === "string" ? state.decisions.find((decision) => decision.id === decisionId) : undefined;
}
