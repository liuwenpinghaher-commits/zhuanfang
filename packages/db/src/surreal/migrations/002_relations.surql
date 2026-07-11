-- P0 · 关系边(= Relation 三元组,spec 01 §3)。统一吞掉三套旧编码(EvidenceAnchor/relatedThemeIds/MemoryEdge)。
-- TYPE RELATION:边本身是记录、可带字段(= Provenance)。P0 不约束 IN/OUT 端类型(P1 视需要收紧)。

-- derived_from: CognitiveEntity → turn(PROV-O wasDerivedFrom),边上挂溯源
DEFINE TABLE IF NOT EXISTS derived_from SCHEMAFULL TYPE RELATION ENFORCED;
DEFINE FIELD IF NOT EXISTS provenance        ON derived_from TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS provenance.origin ON derived_from TYPE string
  ASSERT $value IN ['llm_extracted','user_confirmed','heuristic','imported','seed'];

-- belongs_to_theme: Distillation/Inquiry → theme(RDFS domain/range)
DEFINE TABLE IF NOT EXISTS belongs_to_theme SCHEMAFULL TYPE RELATION ENFORCED;
DEFINE FIELD IF NOT EXISTS weight ON belongs_to_theme TYPE option<float>;

-- about_theme: memory → theme(统一掉 MemoryEdge 双轨)
DEFINE TABLE IF NOT EXISTS about_theme SCHEMAFULL TYPE RELATION ENFORCED;

-- promoted_from: question → note(functional)。
-- 【历史预留·已确认无消费者】R 系列全程未接线:edge-mapper.collectEdges 不投影、persist 不写、
-- 召回/图审计(AUDITED_EDGE_TABLES)不消费,表恒空。刻意保留 DEFINE 不删——迁移按 filename 账本
-- append-only(见 010 用新迁移 OVERWRITE 003 的先例,不改已发布迁移),已上线库亦已建此空表。
-- 如将来要接「观点晋升溯源」语义,照 contradicts/evolves_into 的复活路径做纯应用层接线即可
-- (表已存在,无需新迁移):collectEdges 加投影 + EdgeSpec.edge 联合类型 + AUDITED_EDGE_TABLES。
DEFINE TABLE IF NOT EXISTS promoted_from SCHEMAFULL TYPE RELATION ENFORCED;

-- part_of: turn → session(Mereology)
DEFINE TABLE IF NOT EXISTS part_of SCHEMAFULL TYPE RELATION ENFORCED;

-- corrects: memory_correction → memory。
-- 【历史预留·已确认无消费者】同 promoted_from:R 系列未接线、表恒空、刻意保留 DEFINE。
-- 「记忆修正」当前走 memory_correction 实体 + memory.status 域层建模,未用此图边;
-- 如将来要图层可达,同样照 contradicts/evolves_into 的纯应用层复活路径接线(无需新迁移)。
DEFINE TABLE IF NOT EXISTS corrects SCHEMAFULL TYPE RELATION ENFORCED;

-- contradicts: point ↔ point(symmetric,推理层检出,新能力)
DEFINE TABLE IF NOT EXISTS contradicts SCHEMAFULL TYPE RELATION ENFORCED;

-- evolves_into: theme(t) → theme(t+1)(时序演化)
DEFINE TABLE IF NOT EXISTS evolves_into SCHEMAFULL TYPE RELATION ENFORCED;
