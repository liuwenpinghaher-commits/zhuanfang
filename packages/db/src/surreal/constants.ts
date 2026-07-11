/** DashScope text-embedding-v3 默认输出维度。S0/S5 用真实向量确认;
 *  003_index.surql 的 HNSW DIMENSION 必须与此一致(apply-schema.test.ts 守卫,防漂移)。 */
export const EMBEDDING_DIMENSION = 1024;

/** SurrealDB 命名空间/库(与任何其他用途隔离,spec 01 §1)。 */
export const SURREAL_NS = "interview";
export const SURREAL_DB = "main";

/** R4a · 中文 BM25 查询侧 token 上限(三处混合召回统一口径:memory_ft / rag_ft / kc_ft)。
 *
 *  背景:R4a 把 zh analyzer 从 ngram(2,2) 升到 ngram(1,3)(010_r4a_ngram.surql;单字/短人名召回
 *  0→~99%)。代价是 `search::analyze('zh', q)` 的 token 数约 3 倍(N 字 → ~3N-3 个 1/2/3-gram),
 *  且纯单字 1-gram 的 posting list 极长。R4a 真实体量(11010 chunk)实测:多字查询若把 1-gram 也灌进
 *  `text @@ $t OR ...`,候选集膨胀 10-14x(强化学习 120→1418)、子查询延迟 2ms→53ms,长 query 更是在
 *  cap=48→64 处出现延迟悬崖(533ms→2007ms);而旧 memory/rag(queryText=topicHint,此前【无】去重/钳制)
 *  在 (1,3) 下 uncapped 会直冲 2s+。故 (1,3) 下必须在【消费侧】统一治理 token 集。
 *
 *  统一口径(memory/rag/knowledge 三处混合召回共享,保持逻辑逐字一致):
 *   ① 去重:重复 `text @@ $t` 谓词冗余,去重不改 OR 语义。
 *   ② 择优:token 集里【只要存在 ≥2 字 gram,就丢弃纯单字 1-gram】;仅当全是单字(查询本身是单字/
 *      纯单字串)才保留 1-gram。R4a 复核实证此规则:单字召回 100% 保留(卡 416/420、赌 177/180),
 *      多字查询候选广度回落到 ≈ngram(2,2) 水平(强化学习 1418→119)、真值覆盖【不变】(89/90)、
 *      延迟改善 5-23x(强化学习 53→5ms、长 query 265→55ms)。「只取 2-3gram」被否决——纯单字查询会
 *      0 召回,丢掉本次升级的全部收益。
 *   ③ 上限钳制 32:择优后超长自由文本(如 chat message 上限 3 万字)仍可能剩大量 2-3gram,逐 token OR
 *      语句不能无界膨胀。R4a 复核(11k 语料,长 query,择优后):cap=32→54ms、48→118ms、64→122ms、
 *      96→569ms——择优已消除旧「全 gram」在 48→64 处的延迟悬崖(533→2007ms)。**决定保持 32**:
 *      刻意不上调——① 真正做治理的是「择优」(消噪+降延迟),cap 只是防长文本撑爆语句的安全上界;
 *      ② queryText 来源分两类:memory 路 = 短 topicHint;rag 路含**自由文本 question**(rag.ts,旧
 *      uncapped、现被 cap=32——可接受:question 已在 rag 路 embed 由 HNSW 承载语义,cap 只截 BM25 关键词
 *      广度,与 chat/knowledge 同款);短 topicHint 择优后远不到 32、不触发钳制(仅新增去重/择优)。③ 32 给最低 worst-case(54ms)。
 *      若将来 free-chat 侧要更全的关键词覆盖,48/64 有延迟余量(~120ms)可上调,不触悬崖。 */
export const MAX_BM25_QUERY_TOKENS = 32;

/** R4a · BM25 查询 token 择优+钳制(memory/rag/knowledge 三处混合召回共享,保证口径逐字一致)。
 *  入参是 `search::analyze('zh', queryText)` 的原始 token 串;返回:去重 →(含多字 gram 则丢单字
 *  1-gram、纯单字查询保留)→ 钳制到 MAX_BM25_QUERY_TOKENS 的 token 数组。完整依据见上方常量注释。
 *  说明:这共享 R4a 引入的 token 择优/钳制口径(易漂移、必须一致);R2c 记档的其余机械件已一并提炼为
 *  buildBm25Clause / reorderByRrfRank / RRF_RANK_CONSTANT(见下),三处消费。k/ef 钳制因三处口径各异
 *  (memory 不钳 k、rag/knowledge 钳法不同)且 `ef=Math.max(k*4,40)` 过于琐碎,保留各自 inline。 */
export function selectBm25QueryTokens(analyzed: readonly string[]): string[] {
  const dedup = [...new Set(analyzed.map(String).filter(Boolean))];
  const multi = dedup.filter((t) => [...t].length >= 2);
  return (multi.length > 0 ? multi : dedup).slice(0, MAX_BM25_QUERY_TOKENS);
}

/** R2c · 三处混合召回(memory_ft / rag_ft / kc_ft)的机械件提炼(rule-of-three,均为逐字节等价)。
 *  只抽【无门控/无表名/无列差异】的纯机械部分——门控(A4/usage/无)、取列(SELECT * vs {id,text})、
 *  表名、BM25-only 分支有无仍是本体差异,留在各调用点,绝不参数化进字符串拼接。 */

/** search::rrf 的排名衰减常量(RRF 公式 1/(constant+rank) 的 constant;此处不用符号 k 以免与召回 limit k 混淆)。
 *  三处混合召回字面量同为 60,提为常量消重并单点记录取值依据(60 为 RRF 通用经验值)。 */
export const RRF_RANK_CONSTANT = 60;

/** BM25 OR 谓词串构造:token 列表 → `text @@ $t0 OR text @@ $t1 OR ...` + 对应参数绑定 `{t0,t1,...}`。
 *  三处逐字同款(此前各自 inline 手抄)。谓词列 `text` 三张表一致(memory/rag_chunk/knowledge_chunk 均有 text 列)。
 *  返回 { clause, vars }:clause 直接插入 WHERE、vars 展开进 query 参数——生成的 SQL 文本与旧 inline 逐字节相同。 */
export function buildBm25Clause(tokens: readonly string[]): { clause: string; vars: Record<string, unknown> } {
  const vars: Record<string, unknown> = {};
  const clause = tokens.map((tok, i) => { vars[`t${i}`] = tok; return `text @@ $t${i}`; }).join(" OR ");
  return { clause, vars };
}

/** search::rrf 融合名次 JS 侧重排:`WHERE id IN $fused.map(...)` 取回不保序,按融合名次(order 内下标)升序重排。
 *  rag / knowledge 两处逐字同款(memory 路有域层三因子精排兜底、刻意不在此重排,故非三处)。
 *  order 为已转换的 domain id 序(不同表的 id→domainId 转换函数各异,留在调用点做);未命中名次者沉到末尾(order.length)。
 *  就地排序返回同一数组引用,行为与旧 inline 逐字等价。 */
export function reorderByRrfRank<T extends { id: string }>(rows: T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((rid, idx) => [rid, idx] as const));
  return rows.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
}
