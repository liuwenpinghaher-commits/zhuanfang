// 审计修复(F-01/A1):dual-surreal 启动期权威库检查——纯决策函数测试。
// 场景锚点:近空 surreal 权威首笔写会镜像覆盖 sqlite 冷备真实数据,启动期必须 fail-closed。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductState } from "../../../src/domain/types";
import { createEmptyProductState, createInitialProductState } from "../../../src/domain/engine";
import { assessDualSurrealCutover, readCutoverMarker, userEntityCount, CUTOVER_MARKER_FILENAME } from "./dual-surreal-cutover";

/** 有真实用户数据的状态(1 条观点资产),revision 可指定模拟"写过多轮"。 */
function dataState(revision: number, pointId = "pt_real"): ProductState {
  const base = createEmptyProductState();
  return {
    ...base,
    revision,
    points: [{
      id: pointId, title: "真实观点", content: "c", status: "稳定观点" as const,
      confidence: "用户确认" as const, evidence: [], relatedThemeIds: [], important: false,
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]
  };
}

/** 空库状态(全部用户数组为空)。 */
function emptyState(revision = 0): ProductState {
  return { ...createEmptyProductState(), revision };
}

describe("assessDualSurrealCutover(F-01)", () => {
  it("内容相等 → proceed(revision 各不相同也放行:迁移刚完成的常态)", () => {
    // revision/schemaVersion 是存储层元字段,两库各自 bump,不代表内容差异。
    const surreal = dataState(1);
    const sqlite = dataState(7);
    const res = assessDualSurrealCutover({ surrealState: surreal, sqliteState: sqlite });
    expect(res.action).toBe("proceed");
    expect(res.rule).toBe("equivalent");
    expect(res.detail.surrealDigest8).toBe(res.detail.sqliteDigest8);
  });

  it("双空全新安装 → proceed", () => {
    const res = assessDualSurrealCutover({ surrealState: emptyState(0), sqliteState: emptyState(0) });
    expect(res.action).toBe("proceed");
    expect(res.rule).toBe("equivalent");
  });

  it("处女 surreal(空)+ 有数据 sqlite → fail-closed(F-01 主场景:首笔写会覆盖冷备)", () => {
    const res = assessDualSurrealCutover({ surrealState: emptyState(0), sqliteState: dataState(9) });
    expect(res.action).toBe("fail-closed");
    // 空库 revision 往往同时 <=1,两判据同时命中时 empty 优先(更强证据)。
    expect(res.rule).toBe("suspect-empty");
    expect(res.reason).toContain("拒绝启动");
    expect(res.detail.surrealEntityCount).toBe(0);
    expect(res.detail.sqliteEntityCount).toBeGreaterThan(0);
  });

  it("同场景 + ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH=true → proceed-with-override", () => {
    const res = assessDualSurrealCutover({
      surrealState: emptyState(0), sqliteState: dataState(9), allowMismatchEnv: "true"
    });
    expect(res.action).toBe("proceed-with-override");
    expect(res.rule).toBe("suspect-empty");
    expect(res.reason).toContain("ALLOW_DUAL_SURREAL_AUTHORITY_MISMATCH");
  });

  it("放行 env 仅接受字面 \"true\":其他值(TRUE/1/yes)仍 fail-closed", () => {
    for (const v of ["TRUE", "1", "yes", ""]) {
      const res = assessDualSurrealCutover({
        surrealState: emptyState(0), sqliteState: dataState(9), allowMismatchEnv: v
      });
      expect(res.action).toBe("fail-closed");
    }
  });

  it("处女 surreal 带 demo 种子(实体非 0 但 revision<=1)+ 有数据 sqlite → 仍 fail-closed(revision 分支逮住)", () => {
    // 处女库初始化会种 demo 资产,entityCount>0,单靠实体数判空会漏;revision<=1 && sqliteRev>1 兜住。
    const virginWithDemo = { ...createInitialProductState(), revision: 1 };
    expect(userEntityCount(virginWithDemo)).toBeGreaterThan(0);
    const res = assessDualSurrealCutover({ surrealState: virginWithDemo, sqliteState: dataState(9) });
    expect(res.action).toBe("fail-closed");
    expect(res.rule).toBe("suspect-revision");
    expect(res.reason).toContain("revision");
  });

  it("revision 分支(处女库带 demo 种子)+ override env → proceed-with-override(rule 仍为 suspect-revision)", () => {
    const virginWithDemo = { ...createInitialProductState(), revision: 1 };
    const res = assessDualSurrealCutover({
      surrealState: virginWithDemo, sqliteState: dataState(9), allowMismatchEnv: "true"
    });
    expect(res.action).toBe("proceed-with-override");
    expect(res.rule).toBe("suspect-revision");
  });

  it("边角:surreal revision>1 但核心实体为 0(高版本空库)+ 有数据 sqlite → fail-closed(entityCount 分支逮住)", () => {
    // 例如 surreal 被 reset 清空后 revision 仍高——revision 判据失效,靠实体数判空兜住。
    const res = assessDualSurrealCutover({ surrealState: emptyState(5), sqliteState: dataState(9) });
    expect(res.action).toBe("fail-closed");
    expect(res.rule).toBe("suspect-empty");
    expect(res.detail.surrealRevision).toBe(5);
    expect(res.detail.surrealEntityCount).toBe(0);
  });

  it("双库都有数据但内容发散(普通影子漂移)→ proceed,reason 注明发散与兜底路径", () => {
    // 上次影子写瞬时失败的日常漂移:靠镜像自愈 + getPersistHealth 上报,不熔断。
    const res = assessDualSurrealCutover({ surrealState: dataState(9, "pt_a"), sqliteState: dataState(9, "pt_b") });
    expect(res.action).toBe("proceed");
    expect(res.rule).toBe("divergent");
    expect(res.reason).toContain("发散");
    expect(res.detail.surrealDigest8).not.toBe(res.detail.sqliteDigest8);
  });

  it("surreal 有数据、sqlite 为空(反向:冷备是新盘)→ proceed(不属覆盖真实数据场景)", () => {
    // 冷备被换成空盘时,镜像会把权威数据补进冷备,这是期望的自愈方向,不该熔断。
    const res = assessDualSurrealCutover({ surrealState: dataState(9), sqliteState: emptyState(0) });
    expect(res.action).toBe("proceed");
    expect(res.rule).toBe("divergent"); // 反向(冷备空)属普通发散,由镜像自愈补齐冷备
  });
});

describe("userEntityCount(F-01 判空口径)", () => {
  it("空库为 0;demo 初始态 > 0;运维流水/派生索引不计入", () => {
    expect(userEntityCount(createEmptyProductState())).toBe(0);
    expect(userEntityCount(createInitialProductState())).toBeGreaterThan(0);
    // 只有运维噪音(auditEvents/ragChunks)的库仍视为"无用户数据"——它们可重建/非用户内容。
    const noisy: ProductState = {
      ...createEmptyProductState(),
      revision: 3,
      auditEvents: [{ id: "ae_1" } as unknown as ProductState["auditEvents"][number]],
      ragChunks: [{ id: "rc_1" } as unknown as ProductState["ragChunks"][number]]
    };
    expect(userEntityCount(noisy)).toBe(0);
  });

  it("半损坏 state(数组字段缺失)不抛,当 0 计", () => {
    const broken = { ...createEmptyProductState() } as unknown as Record<string, unknown>;
    delete broken.sessions;
    delete broken.memoryRecords;
    expect(() => userEntityCount(broken as unknown as ProductState)).not.toThrow();
    expect(userEntityCount(broken as unknown as ProductState)).toBe(0);
  });
});

describe("readCutoverMarker(F-01 仅诊断:任何读取失败都返回 null,不构成新的启动失败)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cutover-marker-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("正常 marker → 解析返回对象", () => {
    writeFileSync(join(dir, CUTOVER_MARKER_FILENAME), JSON.stringify({
      migratedAt: "2026-07-10T00:00:00.000Z", sourceSqliteRevision: 9, counts: { points: 1 }
    }));
    const marker = readCutoverMarker(dir);
    expect(marker?.migratedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(marker?.sourceSqliteRevision).toBe(9);
    expect(marker?.counts).toEqual({ points: 1 });
  });

  it("损坏 JSON → null(不抛)", () => {
    writeFileSync(join(dir, CUTOVER_MARKER_FILENAME), "{ migratedAt: 截断的坏 JSON");
    expect(readCutoverMarker(dir)).toBeNull();
  });

  it("合法 JSON 但是数组 → null(marker 必须是对象)", () => {
    writeFileSync(join(dir, CUTOVER_MARKER_FILENAME), JSON.stringify(["not", "an", "object"]));
    expect(readCutoverMarker(dir)).toBeNull();
  });

  it("目录不存在 → null(从未迁移的常态,不抛)", () => {
    expect(readCutoverMarker(join(dir, "does-not-exist"))).toBeNull();
  });
});
