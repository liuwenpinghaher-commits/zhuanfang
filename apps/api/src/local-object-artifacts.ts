import { existsSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { ProductState } from "../../../src/domain/types";

export type LocalObjectArtifactStatus = "deleted" | "missing" | "skipped";
export type LocalObjectArtifactSourceType = "corpus_import" | "import_source" | "rag_chunk" | "podcast_episode";

export interface LocalObjectArtifactReference {
  sourceType: LocalObjectArtifactSourceType;
  sourceId: string;
  sourceUrl: string;
  fileName: string;
}

export interface LocalObjectArtifactPurgeItem {
  fileName: string;
  status: LocalObjectArtifactStatus;
  referenceCount: number;
}

export interface LocalObjectArtifactPurgeResult {
  uploadDir: string;
  referenceCount: number;
  uniqueFileCount: number;
  deleted: number;
  missing: number;
  skipped: number;
  files: LocalObjectArtifactPurgeItem[];
}

interface LocalObjectArtifactOptions {
  corpusUploadDir?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export function purgeLocalObjectArtifactsForState(
  state: ProductState,
  options: LocalObjectArtifactOptions = {}
): LocalObjectArtifactPurgeResult {
  const uploadDir = resolveCorpusUploadDir(options);
  const references = collectLocalObjectArtifactReferences(state);
  const referencesByFileName = groupReferencesByFileName(references);
  const files = [...referencesByFileName.entries()].map(([fileName, fileReferences]) =>
    purgeLocalObjectArtifactFile(uploadDir, fileName, fileReferences.length)
  );

  return {
    uploadDir,
    referenceCount: references.length,
    uniqueFileCount: files.length,
    deleted: files.filter((file) => file.status === "deleted").length,
    missing: files.filter((file) => file.status === "missing").length,
    skipped: files.filter((file) => file.status === "skipped").length,
    files
  };
}

export function collectLocalObjectArtifactReferences(state: ProductState): LocalObjectArtifactReference[] {
  return [
    ...state.corpusImports.flatMap((item) =>
      buildLocalObjectArtifactReference("corpus_import", item.id, item.sourceUrl)
    ),
    ...state.importSources.flatMap((item) =>
      buildLocalObjectArtifactReference("import_source", item.id, item.sourceUrl)
    ),
    ...state.ragChunks.flatMap((item) => buildLocalObjectArtifactReference("rag_chunk", item.id, item.sourceUrl)),
    ...state.podcastEpisodes.flatMap((item) =>
      buildLocalObjectArtifactReference("podcast_episode", item.id, item.audioUrl)
    )
  ];
}

export function resolveCorpusUploadDir(options: LocalObjectArtifactOptions = {}) {
  return options.corpusUploadDir ?? options.env?.CORPUS_UPLOAD_DIR ?? join(options.cwd ?? process.cwd(), ".data", "corpus-audio");
}

export function parseLocalCorpusAudioFileName(sourceUrl: string | undefined) {
  if (!sourceUrl?.startsWith("local-object://corpus-audio/")) {
    return undefined;
  }
  try {
    const parsed = new URL(sourceUrl);
    const fileName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    return fileName && basename(fileName) === fileName ? fileName : undefined;
  } catch {
    return undefined;
  }
}

function buildLocalObjectArtifactReference(
  sourceType: LocalObjectArtifactSourceType,
  sourceId: string,
  sourceUrl: string | undefined
): LocalObjectArtifactReference[] {
  const fileName = parseLocalCorpusAudioFileName(sourceUrl);
  return fileName && sourceUrl ? [{ sourceType, sourceId, sourceUrl, fileName }] : [];
}

function groupReferencesByFileName(references: LocalObjectArtifactReference[]) {
  return references.reduce<Map<string, LocalObjectArtifactReference[]>>((grouped, reference) => {
    const currentReferences = grouped.get(reference.fileName) ?? [];
    currentReferences.push(reference);
    grouped.set(reference.fileName, currentReferences);
    return grouped;
  }, new Map());
}

function purgeLocalObjectArtifactFile(
  uploadDir: string,
  fileName: string,
  referenceCount: number
): LocalObjectArtifactPurgeItem {
  if (basename(fileName) !== fileName) {
    return {
      fileName,
      status: "skipped",
      referenceCount
    };
  }

  const filePath = join(uploadDir, fileName);
  if (!existsSync(filePath)) {
    return {
      fileName,
      status: "missing",
      referenceCount
    };
  }

  rmSync(filePath, { force: true });
  return {
    fileName,
    status: "deleted",
    referenceCount
  };
}
