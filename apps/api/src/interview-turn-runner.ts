import {
  decideInterviewStrategy,
  receiveUserTurn,
  receiveUserTurnWithAssistant
} from "../../../src/domain/engine";
import type {
  AiRunEvent,
  AiRunEventMetrics,
  InterviewSession,
  ProductState
} from "../../../src/domain/types";
import { formatProviderErrorMessage } from "./provider-error";
import type { BailianCharacterInterviewClient } from "./providers/bailian";

export interface InterviewTurnRunResult {
  session: InterviewSession;
  aiRunEvent: Omit<AiRunEvent, "id" | "createdAt">;
}

export async function runInterviewTurn(
  session: InterviewSession,
  content: string,
  bailianInterviewClient: BailianCharacterInterviewClient | undefined
): Promise<InterviewTurnRunResult> {
  const startedAt = Date.now();
  if (!bailianInterviewClient) {
    const updatedSession = receiveUserTurn(session, content);
    return {
      session: updatedSession,
      aiRunEvent: buildInterviewTurnAiRunEvent(updatedSession, {
        providerId: "deterministic-engine",
        status: "degraded",
        inputText: content,
        outputText: latestAssistantContent(updatedSession),
        latencyMs: Date.now() - startedAt,
        degradedReason: "百炼角色专访 provider 未配置，使用本地规则引擎。"
      })
    };
  }

  try {
    const assistant = await bailianInterviewClient.createAssistantTurn({ session, userText: content });
    const latencyMs = Date.now() - startedAt;
    const strategyDecision = decideInterviewStrategy(session, content);
    const updatedSession = receiveUserTurnWithAssistant(session, content, {
      content: assistant.content,
      intent: assistant.intent,
      strategyDecision
    });
    return {
      session: updatedSession,
      aiRunEvent: buildInterviewTurnAiRunEvent(updatedSession, {
        providerId: assistant.providerId,
        status: "succeeded",
        inputText: content,
        outputText: assistant.content,
        latencyMs,
        metrics: { timeToFirstTokenMs: latencyMs }
      })
    };
  } catch (error) {
    const updatedSession = receiveUserTurn(session, content);
    return {
      session: updatedSession,
      aiRunEvent: buildInterviewTurnAiRunEvent(updatedSession, {
        providerId: "bailian-character",
        status: "degraded",
        inputText: content,
        outputText: latestAssistantContent(updatedSession),
        latencyMs: Date.now() - startedAt,
        degradedReason: `百炼角色专访调用失败，已降级到本地规则：${formatErrorMessage(error)}`
      })
    };
  }
}

export function upsertInterviewSession(state: ProductState, session: InterviewSession): ProductState {
  return {
    ...state,
    sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)]
  };
}

export function withInterviewTurnAiRunEvent(
  state: ProductState,
  event: Omit<AiRunEvent, "id" | "createdAt">
): ProductState {
  return {
    ...state,
    aiRunEvents: [
      {
        id: makeId("ai-run"),
        createdAt: new Date().toISOString(),
        ...event
      },
      ...(state.aiRunEvents ?? [])
    ]
  };
}

function buildInterviewTurnAiRunEvent(
  session: InterviewSession,
  input: {
    providerId: string;
    status: AiRunEvent["status"];
    inputText: string;
    outputText: string;
    latencyMs: number;
    degradedReason?: string;
    metrics?: AiRunEventMetrics;
  }
): Omit<AiRunEvent, "id" | "createdAt"> {
  return {
    workflow: "interview_turn_generation",
    providerId: input.providerId,
    status: input.status,
    entityType: "interview_session",
    entityId: session.id,
    inputSummary: `用户表达：${summarizeForAiRun(input.inputText)}`,
    outputSummary:
      input.status === "succeeded"
        ? `百炼角色追问：${summarizeForAiRun(input.outputText)}`
        : `本地规则追问：${summarizeForAiRun(input.outputText)}`,
    latencyMs: input.latencyMs,
    estimatedTokens: estimateTokens(input.inputText, input.outputText),
    degradedReason: input.degradedReason,
    metrics: input.metrics
  };
}

function latestAssistantContent(session: InterviewSession) {
  return [...session.turns].reverse().find((turn) => turn.role === "assistant")?.content ?? "未生成追问。";
}

function summarizeForAiRun(value: string, maxLength = 80) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function estimateTokens(...values: string[]) {
  return Math.max(1, Math.ceil(values.join("").length / 2));
}

function formatErrorMessage(error: unknown) {
  return formatProviderErrorMessage(error);
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}
