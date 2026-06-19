import type {
  MemoryCandidate,
  MemoryEdge,
  MemoryRecord,
  ProductState,
} from "./types";

import { cloneState, makeId, nowIso, withAuditEvent, withAiRunEvent } from "./utils";
import { buildMemoryEdgesForRecord, formatMemoryGraphTargetLabel } from "./context-pack";

import { withMemoryCandidateReview } from "./memoryReview";

export function approveMemoryCandidate(state: ProductState, candidateId: string): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "pending") {
    return state;
  }

  const reviewedAt = nowIso();
  const record: MemoryRecord = {
    id: makeId("memory-record"),
    text: candidate.text,
    status: "confirmed",
    sourceType: candidate.sourceType,
    sourceId: candidate.sourceId,
    evidenceQuote: candidate.evidenceQuote,
    sourceCandidateId: candidate.id,
    sensitivity: candidate.sensitivity,
    createdAt: reviewedAt,
    updatedAt: reviewedAt
  };
  const clonedState = cloneState(state);
  const projectedState: ProductState = {
    ...clonedState,
    memoryRecords: [record, ...(clonedState.memoryRecords ?? [])]
  };
  const memoryEdges = buildMemoryEdgesForRecord(projectedState, record, reviewedAt);
  const nextState: ProductState = {
    ...projectedState,
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "approved",
            reviewedAt
          }
        : item
    ),
    memoryEdges: [...memoryEdges, ...(state.memoryEdges ?? [])]
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_approved",
    label: "候选记忆已确认",
    detail: candidate.text,
    severity: "info",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: reviewedAt
  });
}
export function deleteMemoryRecord(state: ProductState, recordId: string): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  if (!record) {
    return state;
  }

  const deletedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.filter((item) => item.id !== record.id),
    memoryEdges: (state.memoryEdges ?? []).filter((edge) => edge.fromMemoryRecordId !== record.id)
  };

  return withAuditEvent(nextState, {
    type: "memory_record_deleted",
    label: "确认记忆已删除",
    detail: record.text,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: deletedAt
  });
}
export function deprecateMemoryRecord(
  state: ProductState,
  recordId: string,
  deprecatedReason = "用户撤销这条长期记忆。"
): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  if (!record || record.status !== "confirmed") {
    return state;
  }

  const updatedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.map((item) =>
      item.id === record.id
        ? {
            ...item,
            status: "deprecated",
            updatedAt,
            deprecatedReason
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_record_deprecated",
    label: "确认记忆已废弃",
    detail: `${record.text}｜${deprecatedReason}`,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: updatedAt
  });
}
export function rejectMemoryCandidate(state: ProductState, candidateId: string, reviewNote = "用户拒绝写入长期记忆。"): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  if (!candidate || candidate.status !== "pending") {
    return state;
  }

  const reviewedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? {
            ...item,
            status: "rejected",
            reviewedAt,
            reviewNote
          }
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_rejected",
    label: "候选记忆已拒绝",
    detail: `${candidate.text}｜${reviewNote}`,
    severity: "warning",
    entityType: "memory_candidate",
    entityId: candidate.id,
    createdAt: reviewedAt
  });
}
export function updateMemoryCandidateText(state: ProductState, candidateId: string, text: string): ProductState {
  const candidate = state.memoryCandidates.find((item) => item.id === candidateId);
  const revisedText = text.trim();
  if (!candidate || candidate.status !== "pending" || !revisedText || revisedText === candidate.text) {
    return state;
  }

  const updatedAt = nowIso();
  const nextState: ProductState = {
    ...cloneState(state),
    memoryCandidates: state.memoryCandidates.map((item) =>
      item.id === candidate.id
        ? withMemoryCandidateReview({
            ...item,
            text: revisedText
          }, { preserveExisting: false })
        : item
    )
  };

  return withAuditEvent(nextState, {
    type: "memory_candidate_updated",
    label: "候选记忆已修改",
    detail: `从“${candidate.text}”修改为“${revisedText}”。`,
    severity: "warning",
    entityType: "memory_candidate",
    entityId: candidate.id,
    createdAt: updatedAt
  });
}
export function updateMemoryRecordText(state: ProductState, recordId: string, text: string): ProductState {
  const record = state.memoryRecords.find((item) => item.id === recordId);
  const revisedText = text.trim();
  if (!record || record.status !== "confirmed" || !revisedText || revisedText === record.text) {
    return state;
  }

  const updatedAt = nowIso();
  const updatedRecord: MemoryRecord = {
    ...record,
    text: revisedText,
    updatedAt
  };
  const baseState: ProductState = {
    ...cloneState(state),
    memoryRecords: state.memoryRecords.map((item) => (item.id === record.id ? updatedRecord : item)),
    memoryEdges: (state.memoryEdges ?? []).filter((edge) => edge.fromMemoryRecordId !== record.id)
  };
  const nextState: ProductState = {
    ...baseState,
    memoryEdges: [...buildMemoryEdgesForRecord(baseState, updatedRecord, updatedAt), ...baseState.memoryEdges]
  };

  return withAuditEvent(nextState, {
    type: "memory_record_updated",
    label: "确认记忆已修正",
    detail: `从“${record.text}”修正为“${revisedText}”。`,
    severity: "warning",
    entityType: "memory_record",
    entityId: record.id,
    createdAt: updatedAt
  });
}
