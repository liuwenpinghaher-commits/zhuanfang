// 一次性 spike:实测嵌入式 SurrealDB(@surrealdb/node)在本机的能力。
// 用法:  node scripts/spike-surreal.mjs
// 退出码:任一"硬检查"失败 → 1;全部通过 → 0。S5(维度)为软检查,缺 API key 时跳过。
//
// ============ API 锁定 (surrealdb@2.0.4 + @surrealdb/node@3.0.3) ============
// 嵌入引擎版本: surrealdb-3.0.2 (虽然 JS SDK 是 2.0.4,嵌入式 Rust 核心是 3.x)
//
// 正确 init:
//   import { Surreal, createRemoteEngines } from "surrealdb";
//   import { createNodeEngines } from "@surrealdb/node";
//   const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
//   await db.connect(url);   // mem:// 或 surrealkv://<dir>/name
//   await db.use({ namespace: "interview", database: "main" });
//
// db.query() 返回形状: Array — 每个语句返回一项。
//   单条语句: [rows]  其中 rows 是行数组(SELECT 返回对象数组; DDL/CREATE 返回 null 或对象数组)
//   const [rows] = await db.query("SELECT ...;");  // rows: T[]
//
// SurrealDB 3.x 语法偏差(相比 2.x 文档):
//   ✅ HNSW: DEFINE INDEX ... ON t FIELDS f HNSW DIMENSION n DIST COSINE;   (不变)
//   ✅ 全文: DEFINE INDEX ... ON t FIELDS f FULLTEXT ANALYZER zh BM25;       (2.x 是 SEARCH ANALYZER)
//   ✅ 中文 BM25: 必须加 FILTERS ngram(2,2) — class tokenizer 本身不产生子串 token
//            例: DEFINE ANALYZER zh TOKENIZERS class FILTERS ngram(2,2), lowercase;
//   ⚠️  search::rrf(): 签名改变 — 需要额外 limit 参数,旧签名 search::rrf($a,$b) 报 "limit must be a number"
//   ✅ DEFINE EVENT on DELETE 级联: 语法不变; 但 SCHEMAFULL 表必须先 DEFINE FIELD 再写入
//   ✅ surrealkv:// 持久化: 可用; SCHEMAFULL 表 DEFINE FIELD 后重开数据仍在
// ============================================================================
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

let hardFail = false;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.error(`  ❌ ${m}`); hardFail = true; };
const soft = (m) => console.warn(`  ⚠️  ${m}`);
const section = (m) => console.log(`\n=== ${m} ===`);

// 锁定确切的 init API:embedded-only 用 createNodeEngines();spread createRemoteEngines() 与官方文档一致(无远程引擎也无害)。
async function open(url) {
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect(url);
  await db.use({ namespace: "interview", database: "main" });
  return db;
}

async function main() {
  section(`环境`);
  console.log(`  node ${process.version} · platform ${process.platform}/${process.arch}`);

  // ---------- S1: addon 加载 + mem:// + surrealkv:// + 基本读写 ----------
  section(`S1 addon 加载 / 连接 / 基本读写`);
  let db;
  try {
    db = await open("mem://");
    ok("createNodeEngines() 未抛错;mem:// 连接 + use() 成功");
  } catch (e) {
    bad(`addon 加载或 mem:// 连接失败: ${e?.message ?? e}`);
    console.error(e);
    return; // S1 不过,后续无意义
  }
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS probe SCHEMAFULL; DEFINE FIELD IF NOT EXISTS n ON probe TYPE int;");
    await db.query("CREATE probe:a SET n = 1;");
    const [rows] = await db.query("SELECT n FROM probe:a;");
    if (rows?.[0]?.n === 1) ok("DEFINE/CREATE/SELECT 往返正确"); else bad(`SELECT 返回异常: ${JSON.stringify(rows)}`);
  } catch (e) { bad(`基本读写失败: ${e?.message ?? e}`); }
  await db.close();

  // surrealkv:// 持久化协议(生产用)
  // 注意1: SCHEMAFULL 表必须先 DEFINE FIELD label 再写入
  // 注意2: close() 后需 ~100ms 等文件锁完全释放再重开同路径(否则 connect() 挂起)
  const dir = mkdtempSync(join(tmpdir(), "surreal-spike-"));
  try {
    const pdb = await open(`surrealkv://${dir}/surreal`);
    await pdb.query("DEFINE TABLE IF NOT EXISTS probe SCHEMAFULL; DEFINE FIELD IF NOT EXISTS label ON probe TYPE string;");
    await pdb.query("CREATE probe:b SET label = 'persist';");
    await pdb.close();
    await new Promise((r) => setTimeout(r, 150)); // 等文件锁释放
    const pdb2 = await open(`surrealkv://${dir}/surreal`);
    const [rows] = await pdb2.query("SELECT label FROM probe:b;");
    if (rows?.[0]?.label === "persist") ok("surrealkv:// 重开后数据仍在(持久化 OK)"); else bad(`surrealkv:// 持久化异常: ${JSON.stringify(rows)}`);
    await pdb2.close();
  } catch (e) { bad(`surrealkv:// 失败: ${e?.message ?? e}`); }
  finally { rmSync(dir, { recursive: true, force: true }); }

  await runVector();
  await runFulltext();
  await runCascade();
  await runDimension();

  section(`结论`);
  if (hardFail) { console.error("SPIKE FAILED — 见上方 ❌;回 spec 00 §6 评估降级。"); process.exit(1); }
  console.log("SPIKE PASSED — 嵌入式 SurrealDB 在本机可用,P0 可落 schema。");
  process.exit(0); // 强制退出:@surrealdb/node native thread 不会自动释放 event loop
}

// ---------- S2: 向量 HNSW ----------
async function runVector() {
  section(`S2 向量 HNSW + KNN`);
  const db = await open("mem://");
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS v SCHEMAFULL; DEFINE FIELD IF NOT EXISTS e ON v TYPE array<float>;");
    await db.query("DEFINE INDEX IF NOT EXISTS v_emb ON v FIELDS e HNSW DIMENSION 3 DIST COSINE;");
    await db.query("CREATE v:a SET e=[1,0,0]; CREATE v:b SET e=[0,1,0]; CREATE v:c SET e=[0.9,0.1,0];");
    const [rows] = await db.query("SELECT id FROM v WHERE e <|2,40|> [1,0,0];");
    const ids = (rows ?? []).map((r) => String(r.id));
    if (ids.length === 2 && ids.some((s) => s.endsWith("a")) && ids.some((s) => s.endsWith("c")))
      ok(`HNSW KNN 返回最近邻: ${ids.join(", ")}`);
    else bad(`KNN 结果异常(期望 a,c): ${ids.join(", ")}`);
  } catch (e) { bad(`HNSW 不支持/失败: ${e?.message ?? e}`); }
  finally { await db.close(); }
}

// ---------- S3: 全文 BM25 + 中文 analyzer ----------
// 注意 SurrealDB 3.x 语法变化:
//   - SEARCH → FULLTEXT
//   - 中文需要 ngram(2,2) filter:class tokenizer 按字符类切分,中文字符同类,整串一个 token,需 ngram 产生子串
//   - search::rrf($a,$b) 签名改变,需要额外 limit 参数(P2 改用应用层 RRF)
async function runFulltext() {
  section(`S3 全文 BM25 + analyzer`);
  const db = await open("mem://");
  try {
    await db.query("DEFINE TABLE IF NOT EXISTS d SCHEMAFULL; DEFINE FIELD IF NOT EXISTS t ON d TYPE string;");
    // 中文 BM25: class tokenizer(字符类切分) + ngram(2,2) 产生双字子串 token
    await db.query("DEFINE ANALYZER IF NOT EXISTS zh TOKENIZERS class FILTERS ngram(2,2), lowercase;");
    await db.query("DEFINE INDEX IF NOT EXISTS d_ft ON d FIELDS t FULLTEXT ANALYZER zh BM25;");
    await db.query("CREATE d:a SET t='放权与组织设计的权衡'; CREATE d:b SET t='今天的天气很好';");
    const [rows] = await db.query("SELECT id FROM d WHERE t @@ '放权';");
    const ids = (rows ?? []).map((r) => String(r.id));
    if (ids.length >= 1 && ids.some((s) => s.endsWith("a"))) ok(`BM25 @@ 命中: ${ids.join(", ")}`);
    else bad(`全文检索异常(期望命中 a): ${ids.join(", ")}`);
    // search::rrf 在 3.x 签名改变:旧 search::rrf($a,$b) 不可用,需 search::rrf([$a,$b], limit)
    // 实际混合召回建议在 P2 改用应用层 RRF;search::score(n) 仍可用
    try {
      // 验证 search::rrf 存在且新签名不报错(结果可为空)
      await db.query("LET $a = (SELECT id FROM d WHERE t @@ '放权'); LET $b = (SELECT id FROM d WHERE t @@ '组织'); SELECT * FROM d WHERE id IN search::rrf([$a,$b], 10);");
      ok("search::rrf([$a,$b], limit) 语法存在(3.x 新签名);混合召回 P2 用应用层 RRF 实现");
    } catch (e) { soft(`search::rrf() 不可用(P2 改用应用层 RRF): ${e?.message ?? e}`); }
  } catch (e) { bad(`全文/analyzer 不支持/失败: ${e?.message ?? e}`); }
  finally { await db.close(); }
}

// ---------- S4: 级联(A5 机制:DEFINE EVENT on DELETE) ----------
// 注意:SCHEMAFULL 表所有写入字段必须事先 DEFINE FIELD
async function runCascade() {
  section(`S4 级联删除(A5 机制)`);
  const db = await open("mem://");
  try {
    // 先定义所有要写入的字段,再写数据(SCHEMAFULL 强制)
    await db.query("DEFINE TABLE IF NOT EXISTS session SCHEMAFULL; DEFINE FIELD IF NOT EXISTS title ON session TYPE string; DEFINE TABLE IF NOT EXISTS turn SCHEMAFULL; DEFINE FIELD IF NOT EXISTS sessionId ON turn TYPE string;");
    // 删 session → 自动清其 turn(确定性、不调 LLM)
    await db.query(`DEFINE EVENT IF NOT EXISTS cascade_session ON session WHEN $event='DELETE' THEN { DELETE turn WHERE sessionId = meta::id($before.id); };`);
    await db.query("CREATE session:s1 SET title='t'; CREATE turn:t1 SET sessionId='s1'; CREATE turn:t2 SET sessionId='s1';");
    await db.query("DELETE session:s1;");
    const [rows] = await db.query("SELECT id FROM turn WHERE sessionId='s1';");
    if ((rows ?? []).length === 0) ok("DEFINE EVENT on DELETE 级联清子记录成功(A5 可由 DB 强制)");
    else bad(`级联失败,残留 turn: ${JSON.stringify(rows)}`);
  } catch (e) { bad(`DEFINE EVENT 级联不支持/失败(若失败,A5 回退应用层兜底): ${e?.message ?? e}`); }
  finally { await db.close(); }
}

// ---------- S5(软): 确认 bailian text-embedding-v3 真实维度 ----------
async function runDimension() {
  section(`S5 嵌入维度确认(软,需 DASHSCOPE_API_KEY)`);
  const key = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY;
  if (!key) { soft("无 DASHSCOPE/BAILIAN API key,跳过;沿用 text-embedding-v3 默认维度 1024(见 constants.ts)"); return; }
  try {
    const base = process.env.BAILIAN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "text-embedding-v3", input: ["维度探针"] }),
    });
    const json = await res.json();
    const len = json?.data?.[0]?.embedding?.length;
    if (len) { console.log(`  text-embedding-v3 实际维度 = ${len}`); if (len !== 1024) soft(`与默认 1024 不符! 更新 003_index.surql 与 constants.ts 为 ${len}`); else ok("维度 = 1024,与 schema 一致"); }
    else soft(`未取到维度: ${JSON.stringify(json).slice(0, 200)}`);
  } catch (e) { soft(`维度探测失败(不阻塞): ${e?.message ?? e}`); }
}

main().catch((e) => { console.error(e); process.exit(1); });
