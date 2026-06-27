/**
 * P2b:召回数据契约。
 *
 * server 端(surreal 权威)预召回原生图遍历 / HNSW 向量 / 溯源的结果,组装成本纯数据结构,
 * 作为可选参数喂给保持同步的域召回函数。域层只读这个数据,不持有任何 repo / Promise / I/O。
 * 前端 / sqlite / dual(sqlite 权威)不传 → 域函数走现有纯逻辑回落。
 */
export interface RecallProvenanceEntry {
  /** 证据所属资产的表名(如 "point" / "decision")。 */
  assetTable: string;
  /** 证据所属资产的领域 id。 */
  assetId: string;
  /** 沿 derived_from 取到的证据 turn(原话)。 */
  turns: Array<{ id: string; content: string; sessionId: string; role: string }>;
}

export interface RecallResult {
  /** 主题资产 id(图遍历 recallThemeAssets);键对齐原生返回,含 decisions。 */
  themeAssets?: { points: string[]; decisions: string[]; questions: string[]; memories: string[] };
  /** 记忆向量召回命中(HNSW recallMemoriesByVector),按相似度近似序。 */
  memoryHits?: Array<{ id: string; text: string }>;
  /** 溯源:召回出的资产 → 证据 turn(recallProvenanceTurns)。 */
  provenance?: RecallProvenanceEntry[];
}
