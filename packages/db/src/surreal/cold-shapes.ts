import { RecordId } from "surrealdb";
import type { InterviewAudio, InterviewAudioRole, InterviewRawMaterial } from "../../../../src/domain/types";

/**
 * R2b · 冷层三表的「记录 id + CONTENT 载荷」单一真值。
 *
 * 为什么单独成文件:冷层仓库(surreal-cold-repositories.ts)的 put/replaceSource 与 R2b 治理事务
 * (surreal-product-state-repository.ts 的 runGovernanceTransaction)都要生成"同一形状"的冷层写语句。
 * 若把形状留在冷层仓库里、由治理事务从那边 import,就会与"冷层仓库 import 热态仓库"形成循环依赖
 * (surreal-cold-repositories → surreal-product-state-repository → surreal-cold-repositories)。
 * 抽到这个零依赖(只依赖 surrealdb 的 RecordId 与领域类型)的模块,两侧各自 import,单一真值、无环。
 *
 * ⚠️ 改这里的载荷形状 = 同时改冷层仓库落库与治理事务落库,务必与 009_r2a_cold.surql 的 schema 对齐。
 */

export const RAW_MATERIAL_TABLE = "raw_material" as const;
export const AUDIO_TABLE = "audio" as const;
export const KNOWLEDGE_CHUNK_TABLE = "knowledge_chunk" as const;

const DEFAULT_AUDIO_ROLE: InterviewAudioRole = "interviewee";

/** raw_material 记录 id(session_id 主键)。 */
export function rawMaterialRecordId(sessionId: string): RecordId {
  return new RecordId(RAW_MATERIAL_TABLE, sessionId);
}

/** raw_material UPSERT CONTENT 载荷(turns/strategyTrace 为 FLEXIBLE blob;createdAt 转 Date)。 */
export function rawMaterialContentOf(material: InterviewRawMaterial): Record<string, unknown> {
  return {
    turns: material.turns ?? [],
    strategyTrace: material.strategyTrace ?? [],
    createdAt: new Date(material.createdAt),
  };
}

/** audio 复合记录 id [sessionId, role](两路互不覆盖)。role 缺省 interviewee。 */
export function audioRecordId(sessionId: string, role: InterviewAudioRole = DEFAULT_AUDIO_ROLE): RecordId {
  return new RecordId(AUDIO_TABLE, [sessionId, role]);
}

/** audio UPSERT CONTENT 载荷(data 为入库 bytes;可选 durationMs/recordingStartedAt 缺省不写键)。 */
export function audioContentOf(a: InterviewAudio): { role: InterviewAudioRole; content: Record<string, unknown> } {
  const role = a.role ?? DEFAULT_AUDIO_ROLE;
  const content: Record<string, unknown> = {
    sessionId: a.sessionId,
    role,
    data: a.audio,
    mime: a.mime,
    byteSize: a.byteSize ?? a.audio.byteLength,
    createdAt: new Date(a.createdAt),
  };
  if (a.durationMs !== undefined) content.durationMs = a.durationMs;
  if (a.recordingStartedAt !== undefined) content.recordingStartedAt = new Date(a.recordingStartedAt);
  return { role, content };
}
