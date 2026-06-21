import type { ProductState } from "./types";
import { nowIso, withAuditEvent } from "./utils";

/**
 * 删除一条导入素材(importSource)及其在 ragChunks 里的派生块。
 *
 * 不可变：返回新 state，绝不改入参。来源不存在时原样返回(不写审计、不动数组)，
 * 让 UI 端的重复点击/竞态保持幂等。
 *
 * 注意:本函数只清理 ProductState 内的 ragChunks(访谈上下文/候选记忆召回用)。
 * 知识检索索引(KnowledgeIndexRepository / material 块)由服务端"重建知识索引"
 * (/api/knowledge/rebuild)统一清理——本任务不接知识索引删除。
 */
export function deleteImportSource(state: ProductState, sourceId: string): ProductState {
  const source = state.importSources.find((item) => item.id === sourceId);
  if (!source) {
    return state;
  }

  const createdAt = nowIso();
  return withAuditEvent(
    {
      ...state,
      importSources: state.importSources.filter((item) => item.id !== sourceId),
      ragChunks: state.ragChunks.filter((chunk) => chunk.sourceId !== sourceId)
    },
    {
      type: "import_source_deleted",
      label: "导入素材已删除",
      detail: source.title,
      severity: "warning",
      entityType: "import_source",
      entityId: sourceId,
      createdAt
    }
  );
}
