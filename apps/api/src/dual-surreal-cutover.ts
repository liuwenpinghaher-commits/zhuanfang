// 审计修复(F-01/A1):dual-surreal 启动期权威库可疑检查——从"只告警"升级为"默认熔断"。
//
// 背景:dual-surreal 下 surreal 是权威、sqlite 是冷备。dual-write-repository 在权威写成功后
// 会把权威结果整状态镜像进 shadow(replaceState),所以若权威库其实是"近空处女库"(漏跑
// migrate、回退 sqlite 后直接切回等),**首笔写**就会把 sqlite 冷备里的真实用户数据整体覆盖
// 成近空态——覆盖之后两库内容恒等、零告警,数据静默蒸发。启动期只 console.warn 挡不住这条路,
// 必须在监听端口之前 fail-closed。
//
// 本模块是纯决策函数(不碰 fs/网络/进程),server.ts 负责接线与退出;marker 读取是独立的
// 诊断 helper(见 readCutoverMarker 注释:marker 只做诊断,绝不参与放行判定)。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProductState } from "../../../src/domain/types";
// F-01:复用双写仓库运行期同一份内容摘要(忽略 revision/schemaVersion),不再实现第二份口径。
import { contentDigest } from "./dual-write-repository";

export interface DualSurrealCutoverAssessment {
  action: "proceed" | "proceed-with-override" | "fail-closed";
  /**
   * 命中的规则(一等字段,供 server.ts 按规则分发日志——不要靠解析 reason 文案或比对截断
   * digest 反推,那两者都可能被无关改动破坏):
   * - equivalent:规则 a,两库内容等价;
   * - suspect-empty:规则 b,权威核心实体为 0 而冷备有实体(与 suspect-revision 同时命中时
   *   empty 优先,见函数内注释);
   * - suspect-revision:规则 b,权威 revision<=1 而冷备 revision>1(处女库带 demo 种子场景);
   * - divergent:规则 c,双库都有数据的普通影子漂移。
   */
  rule: "equivalent" | "suspect-empty" | "suspect-revision" | "divergent";
  reason: string;
  detail: {
    surrealRevision: number;
    sqliteRevision: number;
    surrealEntityCount: number;
    sqliteEntityCount: number;
    /** digest 前 8 位:够定位"是否同一份内容",又不往日志里灌整串哈希。 */
    surrealDigest8: string;
    sqliteDigest8: string;
  };
}

/**
 * 核心用户数据量(F-01)。
 *
 * 选取标准:回答的是"这个库里到底有没有真实(用户或演示)业务数据",用于识别"近空权威库
 * 覆盖有数据冷备"的灾难路径——所以只显式列出**主要用户数据数组**求和,不追求 ProductState
 * 全集:profile/systemConfig 等单例对象、configVersions/auditEvents/aiRunEvents/workflowRuns/
 * operationalChecks 等运维流水、以及 ragChunks 这类可重建的派生索引,都不能证明"有用户数据",
 * 刻意排除以免把"只有运维噪音的空库"误判成有数据。
 * 另外三个"看似用户数据"的数组也刻意排除:
 * - interviewAnnotations:必附着于既有 session 的批注,session 已计入,不可能出现
 *   "sessions 为 0 但 annotations 有数据"的合法库,单独计入只会重复计数;
 * - profileSuggestions:系统生成的画像**建议**(待采纳的中间产物),采纳后落进 profile,
 *   悬空建议不构成"库里有用户数据"的证据;
 * - playbookPatches:策略打法的配置补丁,属系统配置演进(与 configVersions 同族),非用户内容。
 * 显式列表(而非 Object.values 全扫)还保证:ProductState 未来加字段不会悄悄改变这里的口径。
 */
export function userEntityCount(state: ProductState): number {
  const arrays: unknown[][] = [
    state.sessions,          // 访谈会话(核心)
    state.notes,             // 双轨笔记
    state.points,            // 观点资产
    state.questions,         // 问题资产
    state.decisions,         // 决策资产
    state.debts,             // 知识负债
    state.themes,            // 长期主题
    state.memoryRecords,     // 记忆记录(核心)
    state.memoryCandidates,  // 记忆候选
    state.memoryCorrections, // 记忆纠偏
    state.chatSessions,      // 对话会话
    state.searchBriefs,      // 检索简报
    state.importSources,     // 导入素材源
    state.podcastEpisodes,   // 播客集
    state.corpusImports,     // 语料导入
    state.corpusInsights     // 语料洞察
  ];
  // 防御:异常/半损坏 state 里数组字段可能缺失,当 0 计,不让计数函数自己抛。
  return arrays.reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
}

export interface AssessDualSurrealCutoverInput {
  surrealState: ProductState;
  sqliteState: ProductState;
  /** 环境变量 ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH 的原始值(仅字面 "true" 视为放行)。 */
  allowMismatchEnv?: string;
}

/**
 * dual-surreal 启动期切换决策(F-01,纯函数)。
 *
 * 规则(顺序即优先级):
 *  a. 两库内容摘要相等(忽略 revision/schemaVersion)→ proceed。
 *     涵盖:双空全新安装、迁移刚完成(migrate 后内容等价,revision 各自 bump 无妨)。
 *  b. 内容不等,且疑似"近空权威覆盖有数据冷备":
 *       surreal 实体数为 0 而 sqlite 有实体(revision 高但被清空的边角也逮住),
 *       或 surrealRev<=1 而 sqliteRev>1(处女库带 demo 种子时实体数非 0,靠 revision 逮住)。
 *     → 默认 fail-closed(绝不监听端口);仅当 ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH=true
 *       (人工确认要以 surreal 为准覆盖冷备)时 proceed-with-override。
 *  c. 内容不等但不属 b(两库都有数据的普通影子漂移,如上次影子写瞬时失败)→ proceed。
 *     日常漂移由双写镜像自愈 + getPersistHealth 影子健康度上报兜底,不该熔断——否则一次
 *     瞬时 SQLITE_BUSY 就会把服务永久锁在启动失败,比漂移本身更伤。
 */
export function assessDualSurrealCutover(input: AssessDualSurrealCutoverInput): DualSurrealCutoverAssessment {
  const { surrealState, sqliteState, allowMismatchEnv } = input;
  const surrealDigest = contentDigest(surrealState);
  const sqliteDigest = contentDigest(sqliteState);
  const detail: DualSurrealCutoverAssessment["detail"] = {
    surrealRevision: surrealState.revision ?? 0,
    sqliteRevision: sqliteState.revision ?? 0,
    surrealEntityCount: userEntityCount(surrealState),
    sqliteEntityCount: userEntityCount(sqliteState),
    surrealDigest8: surrealDigest.slice(0, 8),
    sqliteDigest8: sqliteDigest.slice(0, 8)
  };

  // 规则 a:内容等价 → 放行(双空全新安装、迁移刚完成都会落在这)。
  if (surrealDigest === sqliteDigest) {
    return { action: "proceed", rule: "equivalent", reason: "两库内容等价(忽略 revision/schemaVersion),权威切换安全。", detail };
  }

  // 规则 b:近空权威 + 有数据冷备 = 首笔写会静默覆盖真实数据的灾难前兆。
  // 两个判据可能同时命中(空库 revision 往往也 <=1):定义 empty 优先——"实体为 0"是对
  // "近空权威"更直接、更强的证据(revision 只是间接旁证),rule 报最强判据便于运维定位。
  const emptyAuthorityOverData = detail.surrealEntityCount === 0 && detail.sqliteEntityCount > 0;
  const virginAuthorityRevision = detail.surrealRevision <= 1 && detail.sqliteRevision > 1;
  if (emptyAuthorityOverData || virginAuthorityRevision) {
    const rule = emptyAuthorityOverData ? "suspect-empty" as const : "suspect-revision" as const;
    const suspicion = emptyAuthorityOverData
      ? `surreal 权威库核心实体为 0 而 sqlite 冷备有 ${detail.sqliteEntityCount} 条`
      : `surreal 权威库 revision=${detail.surrealRevision}(近处女态)而 sqlite 冷备 revision=${detail.sqliteRevision}`;
    if (allowMismatchEnv === "true") {
      return {
        action: "proceed-with-override",
        rule,
        reason: `${suspicion} —— 已设 ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH=true,人工确认以 surreal 为准继续;首笔写将覆盖 sqlite 冷备。`,
        detail
      };
    }
    return {
      action: "fail-closed",
      rule,
      reason: `${suspicion},疑似漏 migrate 或回退后误切 —— 首笔写会以近空权威镜像覆盖 sqlite 冷备的真实数据,拒绝启动。`,
      detail
    };
  }

  // 规则 c:两库都有数据的普通发散,保持现状语义(放行 + 说明兜底路径)。
  return {
    action: "proceed",
    rule: "divergent",
    reason: "两库内容发散但均有数据(普通影子漂移,如上次影子写瞬时失败)——由双写镜像自愈与影子健康度上报(getPersistHealth)兜底,不熔断。",
    detail
  };
}

// ---------------------------------------------------------------------------
// cutover marker(仅诊断)
// ---------------------------------------------------------------------------

export const CUTOVER_MARKER_FILENAME = "cutover-marker.json";

export interface CutoverMarker {
  migratedAt?: string;
  sourceSqliteRevision?: number;
  /** 迁移时各核心数组的条数明细(migrate 脚本口径)。刻意不存求和总数:migrate 只数 6 个
   *  数组,与本模块 userEntityCount 的 16 数组口径不同,存两个名同义异的"entityCount"
   *  只会让运维在 fail-closed 日志里对不上数。明细自带语义,不会误读。 */
  counts?: Record<string, number>;
  [k: string]: unknown;
}

/**
 * 读取 migrate 脚本落下的 cutover-marker.json(F-01,仅诊断)。
 *
 * 为什么 marker 不能参与放行判定:marker 只证明"某个历史时刻迁移成功过",不证明"当下两库
 * 内容一致"——迁移后回退 sqlite 继续写、再切回 dual-surreal 时 marker 仍在,但 surreal 已经
 * 落后,若凭过期 marker 绕过 digest 检查,恰好放行了本修复要堵的灾难路径。所以 marker 只用来
 * 让 fail-closed 错误信息更可诊断("上次迁移完成于 X / 从未迁移"),放行与否一律由
 * assessDualSurrealCutover 的内容检查决定。
 *
 * 任何读取/解析失败都返回 null(诊断信息缺失不构成新的启动失败原因)。
 */
export function readCutoverMarker(surrealDataDir: string): CutoverMarker | null {
  try {
    const markerPath = join(surrealDataDir, CUTOVER_MARKER_FILENAME);
    if (!existsSync(markerPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as CutoverMarker;
  } catch {
    return null;
  }
}
