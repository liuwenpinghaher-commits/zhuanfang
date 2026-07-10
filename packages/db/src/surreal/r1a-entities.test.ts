import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSurrealProductStateRepository, type SurrealRepoHandle } from "./surreal-product-state-repository";
import { buildR1aFixtureState } from "./r1a-entities.fixture";
import { runScript, lastJsonLine } from "./child-process-test-utils";
import type { ProductState } from "../../../../src/domain/types";

/** R1a · 11 类 state_meta.rest blob 实体真表化的专项测试:
 *  ① roundtrip digest 等价(跨进程 reload)② UPSERT CONTENT 不重跑 DEFAULT 的 datetime 回归
 *  ③ 表级可查(R1 核心收益)④ 旧库新代码:blob 残留被忽略、以表数据为准 ⑤ 枚举钳制↔ASSERT 对齐不 wedge。 */

const open = new Set<SurrealRepoHandle>();
async function makeMem(): Promise<SurrealRepoHandle> {
  const repo = await createSurrealProductStateRepository({ url: "mem://" });
  open.add(repo);
  return repo;
}
afterEach(async () => { for (const r of open) await r.close(); open.clear(); });

const REPO_SRC = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/surreal-product-state-repository.ts"));
const FIXTURE_SRC = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/r1a-entities.fixture.ts"));
const DIGEST_SRC = JSON.stringify(join(process.cwd(), "src/domain/stateDigest.ts"));
const CONNECT_SRC = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/connect.ts"));
const SCHEMA_SRC = JSON.stringify(join(process.cwd(), "packages/db/src/surreal/apply-schema.ts"));
const ENGINE_SRC = JSON.stringify(join(process.cwd(), "src/domain/engine.ts"));

describe("R1a roundtrip 等价 (surrealkv:// 跨进程)", () => {
  it("11 类实体丰富 fixture → replaceState → 重开 loadState:contentDigest 相等 + rest 字段无损", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-r1a-rt-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      // ── 写进程:写入 fixture,打印落库后内存态 digest(revision 归零口径) ──
      const w = runScript(`
import { createSurrealProductStateRepository } from ${REPO_SRC};
import { buildR1aFixtureState } from ${FIXTURE_SRC};
import { buildStableDigest } from ${DIGEST_SRC};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
repo.replaceState(buildR1aFixtureState(repo.getState()));
await repo.flush();
console.log(JSON.stringify({
  digest: buildStableDigest({ ...repo.getState(), revision: 0 }),
  failures: repo.getPersistHealth().consecutiveFailures
}));
await repo.close(); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("写进程失败:\n" + w.stderr);
      const wrote = lastJsonLine(w.stdout) as { digest?: string; failures?: number };
      expect(wrote.failures, "写进程 persist 零失败").toBe(0);

      // ── 读进程:重开 loadState,digest 必须与写进程一致;抽样 rest 深层字段无损 ──
      const r = runScript(`
import { createSurrealProductStateRepository } from ${REPO_SRC};
import { buildStableDigest } from ${DIGEST_SRC};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const s = repo.getState();
console.log(JSON.stringify({
  digest: buildStableDigest({ ...s, revision: 0 }),
  profileName: s.profile.name,
  recencyDays: s.systemConfig.search.recencyDays,
  peScript: s.podcastEpisodes.find(p => p.id === 'pe_a')?.script,
  peChapter: s.podcastEpisodes.find(p => p.id === 'pe_a')?.chapters?.[0]?.title,
  chMsg: s.chatSessions.find(c => c.id === 'ch_a')?.messages?.[0]?.content,
  cvSnapshotVersion: s.configVersions.find(v => v.id === 'cv_a')?.snapshot?.version,
  ppRules: s.playbookPatches.find(p => p.id === 'pp_a')?.rules,
  psCreatedAtType: typeof s.profileSuggestions.find(p => p.id === 'ps_a')?.createdAt,
  chFirst: s.chatSessions[0]?.id,
  cvFirst: s.configVersions[0]?.id
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const read = lastJsonLine(r.stdout) as {
        digest?: string; profileName?: string; recencyDays?: number; peScript?: string; peChapter?: string;
        chMsg?: string; cvSnapshotVersion?: string; ppRules?: string[]; psCreatedAtType?: string;
        chFirst?: string; cvFirst?: string;
      };
      expect(read.digest, "roundtrip contentDigest 等价(顺序敏感)").toBe(wrote.digest);
      // 重载序显式断言:fixture 是生产 prepend 序(newest-first),record id 升序 ≠ 内存序;
      // reload 后仍必须 newest-first(createdAt DESC 重排),否则用户列表重启即倒挂。
      expect(read.chFirst, "chatSessions 重载后仍 newest-first").toBe("ch_b");
      expect(read.cvFirst, "configVersions 重载后仍 newest-first").toBe("cv_b");
      expect(read.profileName, "单例 profile 从表读回").toBe("R1a测试者");
      expect(read.recencyDays, "单例 systemConfig 从表读回").toBe(42);
      expect(read.peScript, "podcast rest 字段无损").toBe("播客台词");
      expect(read.peChapter, "podcast 嵌套 chapters 无损").toBe("开场");
      expect(read.chMsg, "chat messages(rest)无损").toBe("你好");
      expect(read.cvSnapshotVersion, "configVersion snapshot(rest)无损").toBeTruthy();
      expect(read.ppRules, "playbook rules(rest)无损").toEqual(["规则1"]);
      expect(read.psCreatedAtType, "datetime 列 coerce 回 string").toBe("string");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe("R1a 旧库新代码:state_meta.rest blob 残留被忽略 (surrealkv:// 跨进程)", () => {
  it("手工造含 11 键残留的旧 blob → 重开 loadState:以表数据为准(残留不复活)", () => {
    const dir = mkdtempSync(join(tmpdir(), "surreal-r1a-legacy-"));
    try {
      const url = `surrealkv://${dir}/surreal`;
      // ── 进程 1:裸连接 + applySchema,直接写带残留键的 state_meta(模拟 007 之前落的 blob) ──
      const w = runScript(`
import { createSurrealConnection } from ${CONNECT_SRC};
import { applySchema } from ${SCHEMA_SRC};
const db = await createSurrealConnection({ url: ${JSON.stringify(url)} });
await applySchema(db);
await db.query(\`UPSERT state_meta:main SET revision = 7, rest = {
  profile: { name: '残留者' },
  chatSessions: [{ id: 'ch_zombie', title: '残留会话', messages: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  podcastEpisodes: [{ id: 'pe_zombie', title: '残留播客' }],
  auditEvents: [], aiRunEvents: [], workflowRuns: [], operationalChecks: [], schemaVersion: 2
};\`);
await db.close();
console.log('{"ok":true}'); process.exit(0);
`, join(dir, "w.mts"));
      if (w.status !== 0) throw new Error("造残留进程失败:\n" + w.stderr);

      // ── 进程 2:repo 重开。真表全空 → 数组以表为准归空、profile 回退默认值;残留绝不复活 ──
      const r = runScript(`
import { createSurrealProductStateRepository } from ${REPO_SRC};
import { createInitialProductState } from ${ENGINE_SRC};
const repo = await createSurrealProductStateRepository({ url: ${JSON.stringify(url)} });
const s = repo.getState();
console.log(JSON.stringify({
  chatCount: s.chatSessions.length,
  podcastCount: s.podcastEpisodes.length,
  profileIsFallback: s.profile.name === createInitialProductState().profile.name,
  profileNotZombie: s.profile.name !== '残留者',
  revision: s.revision
}));
await repo.close(); process.exit(0);
`, join(dir, "r.mts"));
      if (r.status !== 0) throw new Error("读进程失败:\n" + r.stderr);
      const out = lastJsonLine(r.stdout) as {
        chatCount?: number; podcastCount?: number; profileIsFallback?: boolean; profileNotZombie?: boolean; revision?: number;
      };
      expect(out.chatCount, "chatSessions 以空表为准,blob 残留不复活").toBe(0);
      expect(out.podcastCount, "podcastEpisodes 以空表为准").toBe(0);
      expect(out.profileNotZombie, "profile blob 残留被忽略").toBe(true);
      expect(out.profileIsFallback, "单例表无记录 → normalize 确定性默认值").toBe(true);
      expect(out.revision, "revision 仍从 state_meta 读取").toBe(7);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60000);
});

describe("R1a UPSERT DEFAULT 回归 (mem://)", () => {
  it("同一实体二次 UPSERT(CONTENT 覆盖)后,9 表 datetime 列均非 NONE;persist 零失败", async () => {
    const repo = await makeMem();
    repo.replaceState(buildR1aFixtureState(repo.getState()));
    await repo.flush();
    // 二次 UPSERT:改每类实体首条的一个核心 string 字段(触发 diffById 全量 CONTENT 覆盖)。
    const s = repo.getState();
    repo.replaceState({
      ...s,
      profile: { ...s.profile, name: "R1a测试者二版" },
      profileSuggestions: s.profileSuggestions.map((x) => x.id === "ps_a" ? { ...x, suggestedValue: "更新焦点" } : x),
      interviewAnnotations: s.interviewAnnotations.map((x) => x.id === "an_a" ? { ...x, text: "旁注一改" } : x),
      chatSessions: s.chatSessions.map((x) => x.id === "ch_a" ? { ...x, title: "问答一改" } : x),
      memoryCorrections: s.memoryCorrections.map((x) => x.id === "mc_a" ? { ...x, text: "纠偏一改" } : x),
      podcastEpisodes: s.podcastEpisodes.map((x) => x.id === "pe_a" ? { ...x, title: "第一期改" } : x),
      corpusImports: s.corpusImports.map((x) => x.id === "ci_a" ? { ...x, title: "语料一改" } : x),
      corpusInsights: s.corpusInsights.map((x) => x.id === "cn_a" ? { ...x, title: "洞察一改" } : x),
      playbookPatches: s.playbookPatches.map((x) => x.id === "pp_a" ? { ...x, title: "补丁一改" } : x),
      configVersions: s.configVersions.map((x) => x.id === "cv_a" ? { ...x, reason: "初始改" } : x)
    });
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures, "二次 UPSERT persist 零失败").toBe(0);

    // datetime 列非 NONE(UPSERT CONTENT 不重跑 DEFAULT,靠 fillUpsertDefaults 显式补值)。
    const checks: Array<[string, string]> = [
      ["profile_suggestion", "ps_a"], ["interview_annotation", "an_a"], ["chat_session", "ch_a"],
      ["memory_correction", "mc_a"], ["podcast_episode", "pe_a"], ["corpus_import", "ci_a"],
      ["corpus_insight", "cn_a"], ["playbook_patch", "pp_a"], ["config_version", "cv_a"]
    ];
    for (const [table, id] of checks) {
      const [rows] = await repo.query<[Array<{ createdAt?: unknown }>]>(`SELECT createdAt FROM ${table}:${id};`);
      expect(rows?.[0]?.createdAt, `${table}.createdAt 二次 UPSERT 后不为 NONE`).toBeTruthy();
    }
    // chat_session 的第二个 DEFAULT datetime 列也检查。
    const [ch] = await repo.query<[Array<{ updatedAt?: unknown }>]>("SELECT updatedAt FROM chat_session:ch_a;");
    expect(ch?.[0]?.updatedAt, "chat_session.updatedAt 二次 UPSERT 后不为 NONE").toBeTruthy();
    // 更新确实落库(非旧值)。
    const [pe] = await repo.query<[Array<{ title?: string }>]>("SELECT title FROM podcast_episode:pe_a;");
    expect(pe?.[0]?.title).toBe("第一期改");
  });
});

describe("R1a 表级可查(R1 核心收益,mem://)", () => {
  it("9 数组实体按核心列过滤命中;2 单例可独立读", async () => {
    const repo = await makeMem();
    repo.replaceState(buildR1aFixtureState(repo.getState()));
    await repo.flush();

    const hit = async (sql: string): Promise<number> => {
      const [rows] = await repo.query<[unknown[]]>(sql);
      return (rows ?? []).length;
    };
    expect(await hit("SELECT id FROM profile_suggestion WHERE status = 'pending';"), "profile_suggestion 按 status 可查").toBe(1);
    expect(await hit("SELECT id FROM interview_annotation WHERE sessionId = 'se_x';"), "interview_annotation 按 sessionId 可查").toBe(1);
    expect(await hit("SELECT id FROM chat_session WHERE title = '问答一';"), "chat_session 按 title 可查").toBe(1);
    expect(await hit("SELECT id FROM memory_correction WHERE text = '纠偏一';"), "memory_correction 按 text 可查").toBe(1);
    expect(await hit("SELECT id FROM podcast_episode WHERE status = 'ready';"), "podcast_episode 按 status 可查").toBe(1);
    expect(await hit("SELECT id FROM corpus_import WHERE mediaType = 'audio';"), "corpus_import 按 mediaType 可查").toBe(1);
    expect(await hit("SELECT id FROM corpus_insight WHERE importId = 'ci_a';"), "corpus_insight 按 importId 可查(洞察↔语料外键)").toBe(1);
    expect(await hit("SELECT id FROM playbook_patch WHERE status = 'applied' AND impact = 'high';"), "playbook_patch 按 status+impact 可查").toBe(1);
    expect(await hit("SELECT id FROM config_version WHERE active = true;"), "config_version 按 active 可查").toBe(1);

    const [profRows] = await repo.query<[Array<{ data?: { name?: string } }>]>("SELECT data FROM profile:main;");
    expect(profRows?.[0]?.data?.name, "profile 单例独立读").toBe("R1a测试者");
    const [cfgRows] = await repo.query<[Array<{ data?: { search?: { recencyDays?: number } } }>]>("SELECT data FROM system_config:main;");
    expect(cfgRows?.[0]?.data?.search?.recencyDays, "system_config 单例独立读").toBe(42);
  });
});

describe("R1a 枚举钳制 ↔ schema ASSERT 对齐 (mem://)", () => {
  it("坏枚举/坏 string/坏 bool 经 normalize 钳制后落库不 wedge,DB 值为 fail-closed 兜底", async () => {
    const repo = await makeMem();
    const base = buildR1aFixtureState(repo.getState());
    // 造坏值(绕过类型检查,模拟手工 PUT/坏 import/LLM 漏字段)。
    const bad = {
      ...base,
      profileSuggestions: [{ ...base.profileSuggestions[0], id: "ps_bad", status: "weird", suggestedValue: 42 }],
      podcastEpisodes: [{ ...base.podcastEpisodes[0], id: "pe_bad", status: "bogus", scriptReviewStatus: 123, format: null, title: 42, sourceType: 99 }],
      corpusImports: [{ ...base.corpusImports[0], id: "ci_bad", mediaType: "video", sourceUrl: 7 }],
      playbookPatches: [{ ...base.playbookPatches[0], id: "pp_bad", status: "half-applied", impact: "极高" }],
      configVersions: [{ ...base.configVersions[0], id: "cv_bad", changedBy: "hacker", active: "yes", version: null }]
    } as unknown as ProductState;
    repo.replaceState(bad);
    await repo.flush();
    expect(repo.getPersistHealth().consecutiveFailures, "坏值不 wedge 权威库(normalize 钳制先行)").toBe(0);

    const one = async <T>(sql: string): Promise<T | undefined> => {
      const [rows] = await repo.query<[T[]]>(sql);
      return rows?.[0];
    };
    const ps = await one<{ status: string; suggestedValue: string }>("SELECT status, suggestedValue FROM profile_suggestion:ps_bad;");
    expect(ps?.status, "suggestion 坏 status → pending").toBe("pending");
    expect(ps?.suggestedValue, "坏 string → 空串兜底").toBe("");
    const pe = await one<{ status: string; scriptReviewStatus: string; format: string; title: string }>(
      "SELECT status, scriptReviewStatus, format, title FROM podcast_episode:pe_bad;");
    expect(pe?.status, "podcast 坏 status → draft(不冒充 ready)").toBe("draft");
    expect(pe?.scriptReviewStatus, "坏值不冒充「用户确认」").toBe("待确认");
    expect(pe?.format).toBe("solo");
    expect(pe?.title).toBe("");
    const ci = await one<{ mediaType: string }>("SELECT mediaType FROM corpus_import:ci_bad;");
    expect(ci?.mediaType, "corpus 坏 mediaType → text").toBe("text");
    const pp = await one<{ status: string; impact: string }>("SELECT status, impact FROM playbook_patch:pp_bad;");
    expect(pp?.status, "patch 坏 status → proposed(不冒充 applied)").toBe("proposed");
    expect(pp?.impact).toBe("low");
    const cv = await one<{ changedBy: string; active: boolean; version: string }>("SELECT changedBy, active, version FROM config_version:cv_bad;");
    expect(cv?.changedBy, "坏 changedBy → system(不伪装用户行为)").toBe("system");
    expect(cv?.active, "非严格 true → false").toBe(false);
    expect(cv?.version).toBe("");
  });
});
