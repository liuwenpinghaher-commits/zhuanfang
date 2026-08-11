import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordId } from "surrealdb";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { buildR1bFixtureState, makeAuditEvents, tsOf } from "./r1b-event-streams.fixture";
import { runScript, lastJsonLine } from "./child-process-test-utils";
import { createPurgedProductState } from "../../../../src/domain/privacy";
import { MAX_EVENT_LOG } from "../../../../src/domain/storage";
import type { ProductState } from "../../../../src/domain/types";

/** R1b · 4 类流水实体(auditEvents/aiRunEvents/workflowRuns/operationalChecks)真表化专项:
 *  ① 超窗口 roundtrip:DB 1200 条、内存窗口 1000,reload digest 与钳制后内存态一致
 *  ② 窗口滑动绝不 DELETE(DB 保全史,照 turn/H1 模式)
 *  ③ pruneEventStreams 只删 cutoff 前 + 绝不删内存窗口内条目
 *  ④ reset/purge(all) 清空流水表(含窗口外历史行——隐私优先于保全史,与 turn 级联同口径)
 *  ⑤ 复合数组 record id 的 range 查询按时间段命中
 *  ⑥ 枚举钳制 ↔ ASSERT 对齐不 wedge ⑦ tsField 漂移防御(同实体不裂成两条)。 */

const open = new Set<SurrealRepoHandle>();
async function makeMem(): Promise<SurrealRepoHandle> {
  const repo = await createSurrealProductStateRepository({ url: "mem://" });
  open.add(repo);
  return repo;
}
afterEach(async () => { for (const r of open) await r.close(); open.clear(); });

async function countOf(repo: SurrealRepoHandle, table: string): Promise<number> {
  const [rows] = await repo.query<[Array<{ count?: number }>]>(`SELECT count() FROM ${table} GROUP ALL;`);
  return rows?.[0]?.count ?? 0;
}

const REPO_SRC = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));
const FIXTURE_SRC = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/r1b-event-streams.fixture.ts"));
const DIGEST_SRC = JSON.stringify(join(process.cwd(), "src/domain/stateDigest.ts"));

describe("R1b 超窗口 roundtrip + 窗口滑动不删历史 (surrealkv:// 跨进程)", () => {
  it("DB 存 1200 条 audit、内存窗口 1000:滑出不删、reload digest 与钳制后内存态一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-r1b-rt-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      // ── 写进程:先落满窗(ae_1..ae_1000),再 prepend 200 条新事件(ae_201..ae_1200 进窗,
      //    ae_1..ae_200 从内存窗口滑出)。滑出是内存瘦身不是用户删除 → DB 必须保全 1200 条。 ──
      const w = runScript(`
import { createSurrealProductStateRepository } from ${REPO_SRC};
import { buildR1bFixtureState, makeAuditEvents } from ${FIXTURE_SRC};
import { buildStableDigest } from ${DIGEST_SRC};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
repo.replaceState({ ...buildR1bFixtureState(repo.getState()), auditEvents: makeAuditEvents(1, 1000) });
await repo.flush();
repo.replaceState({ ...repo.getState(), auditEvents: makeAuditEvents(201, 1200) });
await repo.flush();
const [rows] = await repo.query("SELECT count() FROM audit_event GROUP ALL;");
console.log(JSON.stringify({
  digest: buildStableDigest({ ...repo.getState(), revision: 0 }),
  memCount: repo.getState().auditEvents.length,
  dbCount: rows?.[0]?.count ?? 0,
  failures: repo.getPersistHealth().consecutiveFailures
}));
await repo.close(); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("写进程失败:\n" + w.stderr);
      const wrote = lastJsonLine(w.stdout) as { digest?: string; memCount?: number; dbCount?: number; failures?: number };
      expect(wrote.failures, "写进程 persist 零失败").toBe(0);
      expect(wrote.memCount, "内存钳制在滚动窗").toBe(MAX_EVENT_LOG);
      expect(wrote.dbCount, "窗口滑出绝不 DELETE:DB 保全史 1200 条").toBe(1200);

      // ── 读进程:重开 loadState——只取窗口 1000 条(newest-first),digest 与写进程一致;
      //    窗口外 200 条仍在 DB(append-only 保全史)。 ──
      const r = runScript(`
import { createSurrealProductStateRepository } from ${REPO_SRC};
import { buildStableDigest } from ${DIGEST_SRC};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const s = repo.getState();
const [rows] = await repo.query("SELECT count() FROM audit_event GROUP ALL;");
console.log(JSON.stringify({
  digest: buildStableDigest({ ...s, revision: 0 }),
  memCount: s.auditEvents.length,
  first: s.auditEvents[0]?.id,
  last: s.auditEvents[s.auditEvents.length - 1]?.id,
  dbCount: rows?.[0]?.count ?? 0,
  aiFirst: s.aiRunEvents[0]?.id,
  wrRest: s.workflowRuns.find(x => x.id === 'wr_1')?.metadata?.securityInterceptionCount,
  ocRest: s.operationalChecks.find(x => x.id === 'oc_2')?.summary?.skipped,
  ocCount: s.operationalChecks.length,
  createdAtType: typeof s.auditEvents[0]?.createdAt
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const read = lastJsonLine(r.stdout) as {
        digest?: string; memCount?: number; first?: string; last?: string; dbCount?: number;
        aiFirst?: string; wrRest?: number; ocRest?: number; ocCount?: number; createdAtType?: string;
      };
      expect(read.digest, "超窗口 roundtrip digest 等价(loadState 窗口=内存钳制口径)").toBe(wrote.digest);
      expect(read.memCount, "reload 只取窗口条数").toBe(MAX_EVENT_LOG);
      expect(read.first, "newest-first:队首是最新事件").toBe("ae_1200");
      expect(read.last, "窗口尾是第 201 条(1..200 留在 DB 不进内存)").toBe("ae_201");
      expect(read.dbCount, "重开后 DB 仍保全史").toBe(1200);
      expect(read.aiFirst, "aiRunEvents 也 newest-first 重建").toBe("ar_2");
      expect(read.wrRest, "workflow_run rest 字段(metadata)无损").toBe(0);
      expect(read.ocRest, "operational_check rest 字段(summary)无损").toBe(3);
      expect(read.ocCount, "operationalChecks 无窗口:全量读").toBe(2);
      expect(read.createdAtType, "datetime 列 coerce 回 string").toBe("string");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});

describe("R1b 复合数组 record id (mem://)", () => {
  it("range 查询按时间段命中;表级核心列可查(R1 核心收益)", async () => {
    const repo = await makeMem();
    repo.replaceState(buildR1bFixtureState(repo.getState()));
    await repo.flush();
    // audit_event 复合 id [createdAt, 领域id]:ae_1..ae_3 @ tsOf(1..3)。
    // range [tsOf(2)]..[tsOf(4)]:起点前缀含 [tsOf(2),'ae_2'],终点开区间不含 tsOf(4)(无此条)→ ae_2, ae_3。
    const [hits] = await repo.query<[unknown[]]>(
      "SELECT id FROM audit_event:[$a]..[$b];", { a: tsOf(2), b: tsOf(4) }
    );
    expect((hits ?? []).length, "复合 id range 按时间段命中").toBe(2);
    // 终点边界前缀序:[tsOf(3)] < [tsOf(3),'ae_3'] → ae_3 被排除,只剩 ae_2。
    const [edge] = await repo.query<[unknown[]]>(
      "SELECT id FROM audit_event:[$a]..[$b];", { a: tsOf(2), b: tsOf(3) }
    );
    expect((edge ?? []).length, "开区间终点按前缀序排除同刻条目").toBe(1);
    // 表级可查:blob 时代做不到的核心收益。
    const hit = async (sql: string): Promise<number> => {
      const [rows] = await repo.query<[unknown[]]>(sql);
      return (rows ?? []).length;
    };
    expect(await hit("SELECT id FROM audit_event WHERE severity = 'warning';"), "audit 按 severity 可查").toBe(1);
    expect(await hit("SELECT id FROM ai_run_event WHERE status = 'degraded';"), "ai_run 按 status 可查").toBe(1);
    expect(await hit("SELECT id FROM workflow_run WHERE workflow = 'context_pack_build' AND status = 'running';"), "workflow_run 按 workflow+status 可查").toBe(1);
    expect(await hit("SELECT id FROM operational_check WHERE kind = 'provider-smoke';"), "operational_check 按 kind 可查").toBe(1);
  });
});

describe("R1b pruneEventStreams 保留期清理 (mem://)", () => {
  it("只删 cutoff 之前的历史行;内存窗口内条目绝不删(即便 cutoff 更新)", async () => {
    const repo = await makeMem();
    repo.replaceState(buildR1bFixtureState(repo.getState()));
    await repo.flush();
    // 人工造一条窗口外历史行(模拟窗口滑出后的保全史)。
    const oldTs = "2020-01-01T00:00:00.000Z";
    await repo.query(
      "UPSERT $rid CONTENT { type: 'memory_referenced', label: '老', detail: '', severity: 'info', entityType: 'memory', entityId: 'm_old', createdAt: $d, rest: {} };",
      { rid: new RecordId("audit_event", [oldTs, "ae_old"]), d: new Date(oldTs) }
    );
    expect(await countOf(repo, "audit_event")).toBe(4);

    // cutoff 在历史行之后、内存窗口之前 → 只删 ae_old。
    await repo.pruneEventStreams("2026-01-01T00:00:00.000Z");
    expect(await countOf(repo, "audit_event"), "prune 只删 cutoff 前").toBe(3);
    const [rows] = await repo.query<[unknown[]]>("SELECT id FROM audit_event:[$a]..;", { a: tsOf(1) });
    expect((rows ?? []).length, "窗口内 3 条原样保留").toBe(3);

    // cutoff 晚于内存窗口内全部条目 → 有效 cutoff 钳到内存最旧,窗口内一条不删。
    await repo.pruneEventStreams("2099-01-01T00:00:00.000Z");
    expect(await countOf(repo, "audit_event"), "内存窗口内条目绝不删").toBe(3);
    expect(await countOf(repo, "ai_run_event"), "其余流水表同守卫").toBe(2);
    expect(await countOf(repo, "workflow_run")).toBe(2);
    expect(await countOf(repo, "operational_check")).toBe(2);
  });
});

describe("R1b reset / purge(all) 隐私语义 (mem://)", () => {
  it("resetState 清空 4 张流水表,含窗口外历史行(逐 id 删会留残留的反例)", async () => {
    const repo = await makeMem();
    repo.replaceState(buildR1bFixtureState(repo.getState()));
    await repo.flush();
    // 窗口外历史行:diff 基线(只见窗口)不知道它——reset 若按 removeIds 逐 id 删必残留。
    await repo.query(
      "UPSERT $rid CONTENT { type: 'memory_referenced', label: '老', detail: '', severity: 'info', entityType: 'memory', entityId: 'm_old', createdAt: $d, rest: {} };",
      { rid: new RecordId("audit_event", ["2020-01-01T00:00:00.000Z", "ae_old"]), d: new Date("2020-01-01T00:00:00.000Z") }
    );
    expect(await countOf(repo, "audit_event")).toBe(4);

    repo.resetState();
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures, "reset persist 零失败").toBe(0);
    expect(await countOf(repo, "audit_event"), "audit_event 清空(含窗口外历史行)").toBe(0);
    expect(await countOf(repo, "ai_run_event"), "ai_run_event 清空").toBe(0);
    expect(await countOf(repo, "workflow_run"), "workflow_run 清空").toBe(0);
    expect(await countOf(repo, "operational_check"), "operational_check 清空").toBe(0);
  });

  it("purge(all):流水表清空,audit_event 只剩那条 purge 审计事件", async () => {
    const repo = await makeMem();
    repo.replaceState(buildR1bFixtureState(repo.getState()));
    await repo.flush();
    const purged = createPurgedProductState(repo.getState());
    repo.replaceState(purged);
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures, "purge persist 零失败").toBe(0);
    expect(await countOf(repo, "audit_event"), "audit 只剩 purge 事件本身").toBe(1);
    const [rows] = await repo.query<[Array<{ type?: string }>]>("SELECT type FROM audit_event;");
    expect(rows?.[0]?.type, "留下的正是 privacy_data_purged").toBe("privacy_data_purged");
    expect(await countOf(repo, "ai_run_event"), "ai_run_event 清空").toBe(0);
    expect(await countOf(repo, "workflow_run"), "workflow_run 清空").toBe(0);
    expect(await countOf(repo, "operational_check"), "operational_check 清空").toBe(0);
  });
});

describe("C16 streamPurgeMode · journal replaceState 回落 (mem://)", () => {
  it("replaceState(..., { streamPurgeMode: 'governance-keep' }): 满窗替换清扫 prev 窗口", async () => {
    const repo = await makeMem();
    // 活库满窗 + 窗口外历史
    repo.replaceState({ ...buildR1bFixtureState(repo.getState()), auditEvents: makeAuditEvents(1, MAX_EVENT_LOG) });
    await repo.flush();
    await repo.query(
      "UPSERT $rid CONTENT { type: 'memory_referenced', label: '老', detail: '', severity: 'info', entityType: 'memory', entityId: 'm_old', createdAt: $d, rest: {} };",
      { rid: new RecordId("audit_event", ["2020-01-01T00:00:00.000Z", "ae_old"]), d: new Date("2020-01-01T00:00:00.000Z") },
    );
    expect(await countOf(repo, "audit_event")).toBe(MAX_EVENT_LOG + 1);

    // 全部新于活库的满窗备份 + 显式 governance-keep(journal import 路径)
    const imported = makeAuditEvents(MAX_EVENT_LOG + 1, MAX_EVENT_LOG * 2);
    repo.replaceState(
      { ...repo.getState(), auditEvents: imported },
      { streamPurgeMode: "governance-keep" },
    );
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    expect(await countOf(repo, "audit_event"), "journal 回落 keep 清扫").toBe(MAX_EVENT_LOG);
    const [rows] = await repo.query<[Array<{ id?: RecordId }>]>("SELECT id FROM audit_event;");
    const domainIds = (rows ?? []).map((r) => {
      const raw = r.id?.id;
      return Array.isArray(raw) ? String(raw[1]) : streamDomainIdish(r.id);
    });
    expect(domainIds).not.toContain("ae_1");
    expect(domainIds).not.toContain("ae_old");
    expect(domainIds).toContain(`ae_${MAX_EVENT_LOG + 1}`);
  }, 120000);

  function streamDomainIdish(id: unknown): string {
    if (id instanceof RecordId && Array.isArray(id.id)) return String(id.id[1] ?? "");
    return String(id ?? "");
  }
});

describe("R1b 枚举钳制 ↔ schema ASSERT 对齐 (mem://)", () => {
  it("坏 severity/status/string 经 normalize 钳制后落库不 wedge,DB 值为 fail-closed 兜底", async () => {
    const repo = await makeMem();
    const base = buildR1bFixtureState(repo.getState());
    const bad = {
      ...base,
      auditEvents: [{ ...base.auditEvents[0], id: "ae_bad", severity: "loud", label: 42, detail: null }],
      aiRunEvents: [{ ...base.aiRunEvents[0], id: "ar_bad", status: "meh", outputSummary: 7 }],
      workflowRuns: [{ ...base.workflowRuns[0], id: "wr_bad", status: "半途", traceId: null, providerId: 9 }],
      operationalChecks: [{ ...base.operationalChecks[0], id: "oc_bad", status: "ok", kind: 3, detail: undefined }]
    } as unknown as ProductState;
    repo.replaceState(bad);
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures, "坏值不 wedge 权威库(normalize 钳制先行)").toBe(0);

    const one = async <T>(sql: string): Promise<T | undefined> => {
      const [rows] = await repo.query<[T[]]>(sql);
      return rows?.[0];
    };
    const ae = await one<{ severity: string; label: string; detail: string }>("SELECT severity, label, detail FROM audit_event;");
    expect(ae?.severity, "坏 severity → warning(不虚报 critical 不掩成 info)").toBe("warning");
    expect(ae?.label, "坏 string → 空串兜底").toBe("");
    expect(ae?.detail).toBe("");
    const ar = await one<{ status: string; outputSummary: string }>("SELECT status, outputSummary FROM ai_run_event;");
    expect(ar?.status, "坏 status → failed(绝不冒充 succeeded)").toBe("failed");
    expect(ar?.outputSummary).toBe("");
    const wr = await one<{ status: string; traceId: string; providerId: string }>("SELECT status, traceId, providerId FROM workflow_run;");
    expect(wr?.status, "坏 status → failed").toBe("failed");
    expect(wr?.traceId).toBe("");
    expect(wr?.providerId, "坏 providerId → 唯一合法值").toBe("local-workflow-runtime");
    const oc = await one<{ status: string; kind: string; detail: string }>("SELECT status, kind, detail FROM operational_check;");
    expect(oc?.status, "坏 status → failed(绝不冒充 passed)").toBe("failed");
    expect(oc?.kind, "宽面枚举只保证 string(不 ASSERT)").toBe("");
    expect(oc?.detail).toBe("");
  });
});

describe("R1b tsField 漂移防御 (mem://)", () => {
  it("同 id 的 workflow_run 若 startedAt 被上游改动:删旧复合 id,不裂成两条", async () => {
    const repo = await makeMem();
    const base = buildR1bFixtureState(repo.getState());
    repo.replaceState({ ...base, workflowRuns: [base.workflowRuns[0]] });
    await repo.flush();
    expect(await countOf(repo, "workflow_run")).toBe(1);
    // 上游违约:同 id 改 startedAt(理应不可变)→ 复合 id 漂移,防御删旧后仍应只有一条。
    repo.replaceState({
      ...repo.getState(),
      workflowRuns: [{ ...base.workflowRuns[0], startedAt: tsOf(99), status: "succeeded" }]
    });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures).toBe(0);
    expect(await countOf(repo, "workflow_run"), "同实体不裂成两条").toBe(1);
    const [rows] = await repo.query<[Array<{ id: RecordId; status: string }>]>("SELECT id, status FROM workflow_run;");
    expect(rows?.[0]?.status, "新值落库").toBe("succeeded");
    const rid = rows?.[0]?.id;
    expect(Array.isArray(rid?.id), "记录 id 是复合数组").toBe(true);
    expect(String((rid!.id as unknown[])[0]), "复合 id 时间段已更新").toBe(tsOf(99));
    // 正常路径:同 id 只改 status(startedAt 不动)→ UPSERT 覆盖同一复合 id。
    repo.replaceState({
      ...repo.getState(),
      workflowRuns: [{ ...base.workflowRuns[0], startedAt: tsOf(99), status: "failed" }]
    });
    await repo.flush();
    expect(await countOf(repo, "workflow_run"), "状态更新映射到同一复合 id").toBe(1);
  });
});
