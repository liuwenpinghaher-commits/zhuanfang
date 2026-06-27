-- P0 · 关系边(= Relation 三元组,spec 01 §3)。统一吞掉三套旧编码(EvidenceAnchor/relatedThemeIds/MemoryEdge)。
-- TYPE RELATION:边本身是记录、可带字段(= Provenance)。P0 不约束 IN/OUT 端类型(P1 视需要收紧)。

-- derived_from: CognitiveEntity → turn(PROV-O wasDerivedFrom),边上挂溯源
DEFINE TABLE IF NOT EXISTS derived_from SCHEMAFULL TYPE RELATION;
DEFINE FIELD IF NOT EXISTS provenance        ON derived_from TYPE object FLEXIBLE;
DEFINE FIELD IF NOT EXISTS provenance.origin ON derived_from TYPE string
  ASSERT $value IN ['llm_extracted','user_confirmed','heuristic','imported','seed'];

-- belongs_to_theme: Distillation/Inquiry → theme(RDFS domain/range)
DEFINE TABLE IF NOT EXISTS belongs_to_theme SCHEMAFULL TYPE RELATION;
DEFINE FIELD IF NOT EXISTS weight ON belongs_to_theme TYPE option<float>;

-- about_theme: memory → theme(统一掉 MemoryEdge 双轨)
DEFINE TABLE IF NOT EXISTS about_theme SCHEMAFULL TYPE RELATION;

-- promoted_from: question → note(functional)
DEFINE TABLE IF NOT EXISTS promoted_from SCHEMAFULL TYPE RELATION;

-- part_of: turn → session(Mereology)
DEFINE TABLE IF NOT EXISTS part_of SCHEMAFULL TYPE RELATION;

-- corrects: memory_correction → memory
DEFINE TABLE IF NOT EXISTS corrects SCHEMAFULL TYPE RELATION;

-- contradicts: point ↔ point(symmetric,推理层检出,新能力)
DEFINE TABLE IF NOT EXISTS contradicts SCHEMAFULL TYPE RELATION;

-- evolves_into: theme(t) → theme(t+1)(时序演化)
DEFINE TABLE IF NOT EXISTS evolves_into SCHEMAFULL TYPE RELATION;
