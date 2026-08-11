import { describe, it, expect, afterEach } from "vitest";
import { RecordId } from "surrealdb";
import { createSurrealStores, type SurrealStores } from "./surreal-cold-repositories";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { GovernanceInFlightError } from "../../../../apps/api/src/product-state-repository";
import type { InterviewAudio, InterviewRawMaterial, KnowledgeChunk, ProductState } from "../../../../src/domain/types";
import { makeAuditEvents } from "./r1b-event-streams.fixture";
import { MAX_EVENT_LOG } from "../../../../src/domain/storage";

/** R2b · 治理事务(reset/purge/import 真 ACID)的仓库层测试。
 *  全用 mem://(同进程、HNSW 可用;surrealkv 同进程持文件锁,close 后无法同进程重开——既有 r1a/r1b
 *  的持久化断言都走跨进程 tsx 子进程,治理事务的原子性与 mem:// 上逐字节等价,故不重复跨进程装配)。
 *  故障注入走真实坏数据(role 越枚举 / embedding 维度错)→ 触发真 SurrealDB 事务失败,断言整体回滚
 *  (DB + 内存热态 + diff 基线均回到事务前);不 mock db.query,证明的是真 ACID 而非代码分支。 */

const openStores = new Set<SurrealStores>();
const openRepos = new Set<SurrealRepoHandle>();
async function makeStores(): Promise<SurrealStores> {
  const s = await createSurrealStores({ url: "mem://" });
  openStores.add(s);
  return s;
}
async function makeStandalone(): Promise<SurrealRepoHandle> {
  const r = await createSurrealProductStateRepository({ url: "mem://" });
  openRepos.add(r);
  return r;
}
afterEach(async () => {
  for (const s of openStores) await s.close();
  for (const r of openRepos) await r.close();
  openStores.clear();
  openRepos.clear();
});

const raw = (id: string): InterviewRawMaterial => ({ sessionId: id, turns: [], strategyTrace: [], createdAt: "2026-06-21T00:00:00.000Z" });
const rawWithTurn = (sessionId: string, content = "恢复后的用户原话"): InterviewRawMaterial => ({
  sessionId,
  turns: [{
    id: "tu_imported_1",
    sessionId,
    role: "user",
    content,
    intent: "",
    timestamp: "2026-06-21T00:01:00.000Z",
  }],
  strategyTrace: [],
  createdAt: "2026-06-21T00:00:00.000Z",
});
const aud = (id: string): InterviewAudio => ({ sessionId: id, role: "interviewee", audio: new Uint8Array([1, 2, 3]), mime: "audio/webm", byteSize: 3, createdAt: "2026-06-21T00:00:00.000Z" });
const chunk = (id: string): KnowledgeChunk => ({ id, sourceType: "note", sourceId: "s1", title: "t", text: "x", keywords: [], createdAt: "2026-06-22T00:00:00.000Z" });
// 越枚举 role → audio.role 的 schema ASSERT 拒绝 → 冷层 UPSERT 在事务内抛(真 SurrealDB 失败,非 mock)。
const badAudio = (id: string): InterviewAudio => ({ ...aud(id), role: "bogus" as InterviewAudio["role"] });
// 热态写失败注入。原先靠 embedding 维度错(3 ≠ HNSW 1024)在事务内抛;N-01-embedding 落地后,
// clampPersistableEnums(optFloatArray)会把非 1024 维 embedding 钳成 NONE → 不再 wedge。改用**空 record id**:
// SurrealDB 结构性拒绝空 id("Found  for the Record ID but this is not a valid id"),与所有数据卫生钳制
// (embedding/enum/datetime)正交、穿透 normalize,仍在治理事务里触发热态写失败(整体回滚,代际不递增)。
const badMemory = () => ({ id: "", text: "坏记忆", status: "confirmed", sourceType: "profile", sourceId: "s", evidenceQuote: "", sensitivity: "normal", createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" });

const wipeAll = { rawMaterial: { action: "wipe" as const }, audio: { action: "wipe" as const }, knowledgeIndex: { action: "wipe" as const } };
const noteIds = async (repo: SurrealRepoHandle): Promise<string[]> => {
  const [ids] = await repo.query<[unknown[]]>("SELECT VALUE id FROM note;");
  return (ids ?? []).map(String);
};

describe("R2b 治理事务 · 能力探测", () => {
  it("createSurrealStores 的 productState 暴露 runGovernanceTransaction(冷热同连接)", async () => {
    const s = await makeStores();
    expect(typeof s.productState.runGovernanceTransaction).toBe("function");
  });

  it("standalone createSurrealProductStateRepository 不暴露(冷层非同连接 → 回落 journal)", async () => {
    const r = await makeStandalone();
    expect(r.runGovernanceTransaction).toBeUndefined();
  });
});

describe("R2b 治理事务 · 成功路径(mem://)", () => {
  it("reset:热态清空 + 冷层三库清空 + 知识 epoch 递增", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.rawMaterial.put(raw("s1"));
    await s.audio.put(aud("s1"));
    await s.knowledgeIndex.put(chunk("c1"));
    const e0 = await s.knowledgeIndex.epoch();

    const next = await s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);

    expect(next.notes.length).toBe(0);
    expect(next.sessions.length).toBe(0);
    expect(next.revision).toBe(0); // 与 resetState 同语义:createEmptyProductState → revision 0
    expect(s.productState.getState().notes.length).toBe(0);
    expect(await s.rawMaterial.list()).toHaveLength(0);
    expect(await s.audio.listAll()).toHaveLength(0);
    expect(await s.knowledgeIndex.listAll()).toHaveLength(0);
    expect(await s.knowledgeIndex.epoch()).toBe(e0 + 1); // 知识表 SQL 直清,epoch 须被治理事务显式递增
    expect(await noteIds(s.productState)).toHaveLength(0); // 热态 note 表在 DB 里也真被删
  });

  it("★基线推进正确:reset 后重新写入同 id 的实体确实落库(基线未推进则会被 diff 当'无变化'而丢失)", async () => {
    const s = await makeStores();
    await s.productState.flush();
    const demoNote = s.productState.getState().notes[0]; // note-seed-1(reset 前存在)
    expect(demoNote).toBeDefined();

    await s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);
    // 用与 demo 完全相同的 note(含同 id)重新写入。若治理事务未把 lastPersisted 推进到 empty,
    // 下一笔 persist 会以旧基线(仍含 note-seed-1)diff → 判为"无变化"→ 不 UPSERT → DB 里永远缺失。
    const st = s.productState.getState();
    st.notes = [demoNote];
    s.productState.replaceState(st);
    await s.productState.flush();

    expect((await noteIds(s.productState)).some((id) => id.includes("note-seed-1"))).toBe(true);
    expect(s.productState.getPersistHealth().consecutiveFailures).toBe(0);
  });

  it("purge:热态 replace(revision+1)+ 冷层清空原子提交", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.rawMaterial.put(raw("s1"));
    const before = s.productState.getState();
    const purged = { ...before, notes: [], sessions: [], points: [], questions: [], decisions: [], debts: [] } as ProductState;

    const next = await s.productState.runGovernanceTransaction!({ kind: "replace", next: purged }, wipeAll);

    expect(next.revision).toBe((before.revision ?? 0) + 1); // 与 replaceState 同语义
    expect(next.notes.length).toBe(0);
    expect(await s.rawMaterial.list()).toHaveLength(0);
    expect(await noteIds(s.productState)).toHaveLength(0);
  });

  it("import(replace):热态替换 + 冷层 raw/audio replace(知识不入事务,preserve)", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.knowledgeIndex.put(chunk("c_keep")); // 知识不在冷层规格里 → 应保留
    const imported = { ...s.productState.getState(), notes: [] } as ProductState;

    await s.productState.runGovernanceTransaction!(
      { kind: "replace", next: imported },
      { rawMaterial: { action: "replace", materials: [raw("r1"), raw("r2")] }, audio: { action: "replace", audios: [aud("a1")] } }
    );

    expect((await s.rawMaterial.list()).map((m) => m.sessionId).sort()).toEqual(["r1", "r2"]);
    expect(await s.audio.has("a1")).toBe(true);
    expect(await s.knowledgeIndex.listAll()).toHaveLength(1); // preserve:知识索引未被触碰
  });

  it("完整 import:冷层 raw turns 在同一治理事务投影为 turn/part_of/derived_from，热态仍保持 offloaded", async () => {
    const s = await makeStores();
    await s.productState.flush();
    const before = s.productState.getState();
    const sessionId = "se_imported_1";
    const imported = {
      ...before,
      sessions: [{
        id: sessionId,
        mode: "daily",
        strength: "standard",
        status: "completed",
        title: "恢复会话",
        card: {},
        guide: {},
        turns: [],
        rawMaterialOffloaded: true,
        startedAt: "2026-06-21T00:00:00.000Z",
        completedAt: "2026-06-21T00:05:00.000Z",
      }],
      points: [{
        id: "pt_imported_1",
        title: "恢复观点",
        content: "组织提效依赖流程重构",
        status: "稳定观点",
        confidence: "用户确认",
        evidence: [],
        relatedThemeIds: [],
        important: false,
        updatedAt: "2026-06-21T00:05:00.000Z",
        evidenceAnchors: [{ sessionId, turnId: "tu_imported_1" }],
      }],
    } as unknown as ProductState;

    await s.productState.runGovernanceTransaction!(
      { kind: "replace", next: imported },
      { rawMaterial: { action: "replace", materials: [rawWithTurn(sessionId)] } },
    );

    expect(s.productState.getState().sessions[0]?.turns).toEqual([]);
    const [turnIds] = await s.productState.query<[unknown[]]>("SELECT VALUE id FROM turn;");
    expect((turnIds ?? []).map(String).some((id) => id.includes("tu_imported_1"))).toBe(true);
    const [partOf] = await s.productState.query<[unknown[]]>("SELECT VALUE ->part_of->session FROM turn:tu_imported_1;");
    expect(partOf?.[0]).toHaveLength(1);
    const provenance = await s.productState.recallProvenanceTurns("point", "pt_imported_1");
    expect(provenance).toEqual([
      expect.objectContaining({ id: "tu_imported_1", sessionId, content: "恢复后的用户原话", role: "user" }),
    ]);
    expect(await s.productState.auditGraphConsistency()).toMatchObject({ ok: true, danglingProvenanceCount: 0 });

    // 模拟既有库已漂移，但热态基线与导入包资产完全相同。若 import 仍只做 prev→next edge diff，
    // derived_from 不会被判为 added，重导同一备份也修不回缺边。
    await s.productState.query("DELETE derived_from WHERE in = point:pt_imported_1;");
    expect(await s.productState.recallProvenanceTurns("point", "pt_imported_1")).toEqual([]);

    await s.productState.runGovernanceTransaction!(
      { kind: "replace", next: imported },
      { rawMaterial: { action: "replace", materials: [rawWithTurn(sessionId)] } },
    );

    expect(await s.productState.recallProvenanceTurns("point", "pt_imported_1")).toEqual([
      expect.objectContaining({ id: "tu_imported_1", sessionId, content: "恢复后的用户原话" }),
    ]);
    expect(await s.productState.auditGraphConsistency()).toMatchObject({ ok: true, missingCount: 0, danglingProvenanceCount: 0 });
  });

  it("import(preserve-cold):冷层规格缺省 → 只替换热态,冷层原样保留", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.rawMaterial.put(raw("keep"));
    await s.audio.put(aud("keep"));
    const imported = { ...s.productState.getState(), notes: [] } as ProductState;

    await s.productState.runGovernanceTransaction!({ kind: "replace", next: imported }, {}); // 冷层全缺省

    expect((await s.rawMaterial.list()).map((m) => m.sessionId)).toEqual(["keep"]);
    expect(await s.audio.has("keep")).toBe(true);
  });

  it("S1:多条 MB 级 audio bytes 的 import 单事务提交(大 bytes 入同一 BEGIN...COMMIT 不撞上限)", async () => {
    // 冒烟守卫:治理把全部 audio bytes 拼进单事务 vars(旧 journal 逐条 autocommit,峰值仅单条)。
    // 此处 3×4MB=12MB 验证多条 MB 级 bytes 同事务提交 + 逐字节回读正确;更大体量(48MB→108ms、
    // 峰值 RSS 数倍于载荷)另由一次性 spike 实测,64MB 上限内单用户路径可接受(见报告 S1)。
    const s = await makeStores();
    await s.productState.flush();
    const mkAudio = (id: string, mb: number): InterviewAudio => {
      const bytes = new Uint8Array(mb * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i >> 12) & 0xff; // 稀疏标记,验证不是全零
      return { sessionId: id, role: "interviewee", audio: bytes, mime: "audio/webm", byteSize: bytes.byteLength, createdAt: "2026-06-21T00:00:00.000Z" };
    };
    const audios = [mkAudio("big0", 4), mkAudio("big1", 4), mkAudio("big2", 4)];
    const imported = { ...s.productState.getState(), notes: [] } as ProductState;

    await s.productState.runGovernanceTransaction!(
      { kind: "replace", next: imported },
      { audio: { action: "replace", audios }, rawMaterial: { action: "replace", materials: [raw("r1")] } }
    );

    const rows = await s.audio.listAll();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.audio.byteLength === 4 * 1024 * 1024)).toBe(true); // 逐条 bytes 完整回读
    expect((await s.rawMaterial.list()).map((m) => m.sessionId)).toEqual(["r1"]);
  });
});

describe("R2b 治理事务 · 整体回滚(mem://,真 SurrealDB 事务失败)", () => {
  it("冷层写失败(audio role 越枚举)→ 整体回滚:热态 + 冷层 + 基线均未变", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.rawMaterial.put(raw("keep"));
    await s.audio.put(aud("keep"));
    const before = s.productState.getState();
    const beforeNoteIds = await noteIds(s.productState);
    expect(beforeNoteIds.length).toBeGreaterThan(0); // demo 有 note

    // import 恢复一条越枚举 audio → 冷层 UPSERT 在事务内抛。热态本应清空 notes,但整体回滚后 notes 仍在。
    const imported = { ...before, notes: [] } as ProductState;
    await expect(
      s.productState.runGovernanceTransaction!({ kind: "replace", next: imported }, { audio: { action: "replace", audios: [badAudio("bad")] } })
    ).rejects.toThrow();

    // 内存热态未推进(revision/notes 均为事务前值)——证明 state 与 lastPersisted 都没动。
    expect(s.productState.getState().revision).toBe(before.revision);
    expect(s.productState.getState().notes.length).toBe(before.notes.length);
    // DB 整体回滚:note 表未被清空、旧 audio(keep)仍在、坏 audio 未落库。
    expect(await noteIds(s.productState)).toEqual(beforeNoteIds);
    expect(await s.audio.has("keep")).toBe(true);
    expect(await s.audio.has("bad")).toBe(false);
    expect((await s.rawMaterial.list()).map((m) => m.sessionId)).toEqual(["keep"]);
  });

  it("热态写失败(memory embedding 维度错)→ 整体回滚:冷层未被清空", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.rawMaterial.put(raw("keep"));
    await s.audio.put(aud("keep"));
    await s.knowledgeIndex.put(chunk("c_keep"));
    const before = s.productState.getState();

    // 治理 replace 的热态含维度错 memory → 热态节点 UPSERT 在事务内抛;冷层本应被 wipe,整体回滚后仍在。
    const badState = { ...before, memoryRecords: [badMemory()] } as unknown as ProductState;
    await expect(
      s.productState.runGovernanceTransaction!({ kind: "replace", next: badState }, wipeAll)
    ).rejects.toThrow();

    expect(s.productState.getState().revision).toBe(before.revision); // 基线/内存未推进
    expect(await s.rawMaterial.list()).toHaveLength(1); // 冷层未被清(回滚)
    expect(await s.audio.has("keep")).toBe(true);
    expect(await s.knowledgeIndex.listAll()).toHaveLength(1);
  });

  it("★回滚后基线仍为事务前:后续普通 replaceState 以正确基线增量落库(不复活、不漏写)", async () => {
    const s = await makeStores();
    await s.productState.flush();
    const before = s.productState.getState();
    const beforeNoteIds = await noteIds(s.productState);

    // 一次失败的治理事务(不推进基线)。
    await expect(
      s.productState.runGovernanceTransaction!({ kind: "replace", next: { ...before, memoryRecords: [badMemory()] } as unknown as ProductState }, wipeAll)
    ).rejects.toThrow();

    // 随后正常 replaceState 删掉 demo note:以正确基线(=事务前)diff → DELETE note-seed-1。
    const st = s.productState.getState();
    st.notes = [];
    s.productState.replaceState(st);
    await s.productState.flush();

    expect(await noteIds(s.productState)).toHaveLength(0); // 若基线被错误推进,这里可能删不掉/漏删
    expect(s.productState.getPersistHealth().consecutiveFailures).toBe(0); // 后续写健康
    void beforeNoteIds;
  });
});

describe("R2b 治理事务 · M1 并发写护栏(治理在途拒绝并发整状态写,防复活)", () => {
  it("★治理在途 → 并发 replaceState/resetState 抛 GovernanceInFlightError;结算后 DB+内存 note 同为空(不复活)", async () => {
    const s = await makeStores();
    await s.productState.flush();
    const demoNote = s.productState.getState().notes[0];
    expect(demoNote).toBeDefined();
    expect(await noteIds(s.productState)).not.toHaveLength(0); // 复现前提:治理前 DB 有个人 note

    // 启动治理 reset(不 await)——in-flight 计数在函数体内同步升起。
    const gov = s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);
    // 同 tick 并发整状态写(模拟写槽被强放后抢到的 PUT / 后台终写):此刻 getState 仍是"未清空的旧
    // state",若放行会以旧快照排到治理之后、以治理推进的新基线把个人 note UPSERT 回权威库(复活)。
    // 护栏必须同步拒绝。
    expect(() => s.productState.replaceState({ ...s.productState.getState(), notes: [demoNote] })).toThrow(GovernanceInFlightError);
    expect(() => s.productState.resetState()).toThrow(GovernanceInFlightError);

    await gov; // 治理提交、基线推进、计数落下
    await s.productState.flush();
    // 关键断言:getState 与 DB note 表**同为空**——racing 写被拒,个人数据没被复活。
    expect(s.productState.getState().notes).toHaveLength(0);
    expect(await noteIds(s.productState)).toHaveLength(0);
  });

  it("in-flight 计数贯穿'已排队未执行'窗口:治理排在挂起 persist 之后时,并发写同样被拒", async () => {
    const s = await makeStores();
    await s.productState.flush();
    // 先制造一笔挂起的 persist(replaceState 同步入队、异步落库),治理随即排到它之后——此刻治理尚未
    // 执行,但 in-flight 计数已在 runGovernanceTransaction 函数体同步升起。
    s.productState.replaceState(s.productState.getState());
    const gov = s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);
    expect(() => s.productState.replaceState(s.productState.getState())).toThrow(GovernanceInFlightError);
    await gov;
    await s.productState.flush();
    // 结算后护栏解除:普通写恢复,不再抛。
    expect(() => s.productState.replaceState(s.productState.getState())).not.toThrow();
  });

  it("standalone(无治理能力)不装护栏:replaceState 从不因治理被拒", async () => {
    const r = await makeStandalone();
    expect(() => r.replaceState(r.getState())).not.toThrow();
    expect(() => r.resetState()).not.toThrow();
  });
});

describe("N-03 冷层直写守卫(治理在途拒绝 put/replaceSource,防隐私假清空)", () => {
  it("★治理在途 → 冷层 put/replaceSource 抛 GovernanceInFlightError;结算后无残留(而热态 replaceState 早已被 M1 拒)", async () => {
    const s = await makeStores();
    await s.productState.flush();

    // 复现前提:治理前冷层是干净的(下面写的若漏进,就是治理提交后的残留)。
    expect(await s.audio.listAll()).toHaveLength(0);
    expect(await s.rawMaterial.list()).toHaveLength(0);

    // 启动治理 reset(不 await)——inFlightCount 在函数体内同步升起,与三冷层共享同一 ctx。
    const gov = s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);

    // 同一 tick(治理执行体尚在 microtask 队列、inFlightCount=1)内并发冷层直写:模拟 360s 写门强放后
    // 排队的录音上传 / raw PUT / 后台知识回写趁隙进门。共享守卫必须与热态 M1 同步拒绝(隐私假清空的正解)。
    const rejections = Promise.all([
      expect(s.audio.put(aud("leak"))).rejects.toBeInstanceOf(GovernanceInFlightError),
      expect(s.rawMaterial.put(raw("leak"))).rejects.toBeInstanceOf(GovernanceInFlightError),
      expect(s.knowledgeIndex.put(chunk("leak"))).rejects.toBeInstanceOf(GovernanceInFlightError),
      expect(s.knowledgeIndex.replaceSource("note", "leak", [chunk("leak2")])).rejects.toBeInstanceOf(GovernanceInFlightError),
    ]);
    await rejections;

    await gov; // 治理提交、基线推进、inFlightCount 落下
    await s.productState.flush();

    // 关键断言:治理提交后三冷层同为空——被拒的冷层写没有把私密录音/逐字稿/索引块复活回权威库。
    expect(await s.audio.listAll()).toHaveLength(0);
    expect(await s.rawMaterial.list()).toHaveLength(0);
    expect(await s.knowledgeIndex.listAll()).toHaveLength(0);
  });

  it("守卫精确:治理结算后冷层写恢复(非永久封锁,不误伤正常路径);治理前的写也照常通过", async () => {
    const s = await makeStores();
    await s.productState.flush();

    // 治理前:冷层写正常通过(守卫只在 inFlightCount>0 时生效)。
    await s.audio.put(aud("before"));
    expect(await s.audio.has("before")).toBe(true);

    // 一次完整治理(wipe)。
    await s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);
    await s.productState.flush();
    expect(await s.audio.has("before")).toBe(false); // 被治理清空

    // 治理后:冷层写再次正常通过——守卫已随 inFlightCount 落下解除。
    await s.audio.put(aud("after"));
    expect(await s.audio.has("after")).toBe(true);
  });

  it("delete 类写不被守卫误伤(移除数据永不构成'治理后残留',守 delete 只会误伤在途清理)", async () => {
    const s = await makeStores();
    await s.productState.flush();
    await s.audio.put(aud("d1"));

    const gov = s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);
    // delete/deleteAll/deleteBySource 在治理在途时不抛(它们与治理清空同向,不是隐私违背)。
    await expect(s.audio.delete("d1")).resolves.not.toThrow();
    await gov;
    await s.productState.flush();
    expect(await s.audio.listAll()).toHaveLength(0);
  });
});

describe("C16 streamPurgeMode · 满窗 import 缺口 #6 (governance-keep)", () => {
  it("runGovernanceTransaction replace: 满窗且全部新于活库 → prev 窗口行 + 窗口外历史不得残留", async () => {
    const s = await makeStores();
    await s.productState.flush();

    // 活库满窗 ae_1..ae_1000(ts 1..1000)。纯 diff 下,用「全部更新」的满窗备份覆盖时
    // isSlideOut 会把 removeIds 全判为滑出 → 不触发 keep 清扫(缺口 #6)。
    const liveWindow = makeAuditEvents(1, MAX_EVENT_LOG);
    s.productState.replaceState({ ...s.productState.getState(), auditEvents: liveWindow });
    await s.productState.flush();
    expect(s.productState.getPersistHealth().consecutiveFailures).toBe(0);

    // 窗口外历史行:基线看不见;keep 清扫必须连带删掉(隐私,非逐 id 删)。
    const oldTs = "2020-01-01T00:00:00.000Z";
    await s.productState.query(
      "UPSERT $rid CONTENT { type: 'memory_referenced', label: '老', detail: '', severity: 'info', entityType: 'memory', entityId: 'm_old', createdAt: $d, rest: {} };",
      { rid: new RecordId("audit_event", [oldTs, "ae_old"]), d: new Date(oldTs) },
    );

    const countOf = async (table: string): Promise<number> => {
      const [rows] = await s.productState.query<[Array<{ count?: number }>]>(`SELECT count() FROM ${table} GROUP ALL;`);
      return rows?.[0]?.count ?? 0;
    };
    expect(await countOf("audit_event")).toBe(MAX_EVENT_LOG + 1);

    // 备份:恰满窗且全部新于活库(ae_1001..ae_2000)。治理事务强制 streamPurgeMode=governance-keep。
    const importedWindow = makeAuditEvents(MAX_EVENT_LOG + 1, MAX_EVENT_LOG * 2);
    const nextHot = { ...s.productState.getState(), auditEvents: importedWindow } as ProductState;
    await s.productState.runGovernanceTransaction!({ kind: "replace", next: nextHot }, {});

    expect(s.productState.getPersistHealth().consecutiveFailures, "治理 import 零失败").toBe(0);
    expect(await countOf("audit_event"), "仅保留导入窗口,prev 窗口与窗口外历史均清").toBe(MAX_EVENT_LOG);
    const [ids] = await s.productState.query<[Array<{ id?: unknown }>]>("SELECT id FROM audit_event;");
    const domainIds = (ids ?? []).map((row) => {
      const id = row.id as { id?: unknown } | undefined;
      const arr = id && typeof id === "object" && "id" in id ? (id as { id: unknown }).id : id;
      return Array.isArray(arr) ? String(arr[1]) : String(arr ?? "");
    });
    expect(domainIds).toContain(`ae_${MAX_EVENT_LOG * 2}`);
    expect(domainIds).toContain(`ae_${MAX_EVENT_LOG + 1}`);
    expect(domainIds).not.toContain("ae_1");
    expect(domainIds).not.toContain("ae_old");
    expect(domainIds).not.toContain(`ae_${MAX_EVENT_LOG}`);
  }, 120000);
});

describe("N-05 治理代际(getGovernanceGeneration:后台长任务据此丢弃陈旧产出)", () => {
  it("初始为 0;每次治理事务成功递增(reset/purge/import 都算)", async () => {
    const s = await makeStores();
    await s.productState.flush();
    expect(s.productState.getGovernanceGeneration()).toBe(0);

    await s.productState.runGovernanceTransaction!({ kind: "reset" }, wipeAll);
    expect(s.productState.getGovernanceGeneration()).toBe(1);

    const purged = { ...s.productState.getState(), notes: [] } as ProductState;
    await s.productState.runGovernanceTransaction!({ kind: "replace", next: purged }, wipeAll);
    expect(s.productState.getGovernanceGeneration()).toBe(2);

    await s.productState.runGovernanceTransaction!({ kind: "replace", next: { ...s.productState.getState(), points: [] } as ProductState }, {});
    expect(s.productState.getGovernanceGeneration()).toBe(3);
  });

  it("失败的治理事务(整体回滚)不递增代际——只有真正发生的整库替换才计数", async () => {
    const s = await makeStores();
    await s.productState.flush();
    const g0 = s.productState.getGovernanceGeneration();
    await expect(
      s.productState.runGovernanceTransaction!(
        { kind: "replace", next: { ...s.productState.getState(), memoryRecords: [badMemory()] } as unknown as ProductState },
        wipeAll
      )
    ).rejects.toThrow();
    expect(s.productState.getGovernanceGeneration()).toBe(g0); // 回滚 → 代际不动
  });
});
