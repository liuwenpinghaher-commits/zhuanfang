// 本地 embedding(B2 · 完全离线):transformers.js 在本机 CPU 跑 bge-large-zh-v1.5
// (1024 维,正好匹配 HNSW DIMENSION),替代云端 DashScope text-embedding-v3。
//
// 动机:创建 session 会实时调 embedding 给召回排序;走云端 DashScope 时无 timeout、
// 网络/限流一抖动整个"开始专访"就卡死(冒烟实测多次失败)。本地化后 embed ~数十 ms/句、
// 零网络依赖。注意:这只本地化 embedding/召回;LLM(采访追问/finalize)仍是云端。
//
// 模型:首次需联网下载到 HuggingFace 缓存(~/.cache/huggingface),之后完全离线复用。
// 量化 q8 体积/速度友好;质量略低于 text-embedding-v3 但中文检索够用。
import { existsSync, mkdirSync } from "node:fs";
import type { BailianEmbeddingClient } from "./bailian";

export const LOCAL_EMBEDDING_MODEL = "Xenova/bge-large-zh-v1.5"; // 1024 维 = constants EMBEDDING_DIMENSION

function resolveCacheDir(): string | undefined {
  const explicit = (process.env.TRANSFORMERS_CACHE ?? process.env.HF_HOME ?? "").trim();
  if (explicit) return explicit;
  if (existsSync("/app/.data")) return "/app/.data/hf-cache";
  return undefined;
}

function resolveRemoteHost(): string | undefined {
  const endpoint = (process.env.HF_ENDPOINT ?? "").trim();
  return endpoint ? endpoint.replace(/\/$/, "") : undefined;
}

// 进程级单例:首次 pipeline() 加载模型 ~20s(下载缓存命中后是纯加载),之后每次 embed 复用。
// 用 promise 缓存避免并发首调重复加载。
type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean; truncation: boolean }
) => Promise<{ tolist(): number[][] }>;
let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      // 动态 import:避免在未启用本地 embedding 时把 transformers.js 拉进启动路径。
      const mod = (await import("@huggingface/transformers")) as unknown as {
        pipeline: (task: string, model: string, opts: { dtype: string; cache_dir?: string }) => Promise<Extractor>;
        env?: { cacheDir?: string; remoteHost?: string };
      };
      const cacheDir = resolveCacheDir();
      if (cacheDir) {
        mkdirSync(cacheDir, { recursive: true });
        if (mod.env) mod.env.cacheDir = cacheDir;
      }
      const remoteHost = resolveRemoteHost();
      if (remoteHost && mod.env) mod.env.remoteHost = remoteHost;
      console.info(JSON.stringify({
        event: "local_embedding_load_start",
        model: LOCAL_EMBEDDING_MODEL,
        cacheDir: cacheDir ?? null,
        remoteHost: remoteHost ?? null
      }));
      return mod.pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL, {
        dtype: "q8",
        ...(cacheDir ? { cache_dir: cacheDir } : {})
      });
    })().catch((err) => {
      // 加载失败 → 重置单例,下次可重试(否则永久 reject)。
      extractorPromise = null;
      throw err;
    });
  }
  return extractorPromise;
}

/** 本地 embedding client,实现与云端相同的 BailianEmbeddingClient 接口(embed → number[][])。 */
export function createLocalEmbeddingClient(): BailianEmbeddingClient {
  return {
    providerId: "local:bge-large-zh-v1.5",
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const extractor = await getExtractor();
      // bge-large-zh 的 position embedding 上限 512 token。实测 knowledge reindex 出现
      // "broadcast 512 by 2002" 维度错误 = 超长输入没被截断、直接喂进模型。显式开 truncation
      // (tokenizer 截到 model_max_length);再用保守字符上限兜底,防个别 transformers.js 版本
      // truncation 不透传(中文≈1字符1token,480 字符 +[CLS][SEP] 稳落 512 内,仍保留主体语义)。
      // 截断是模型能力硬边界(等价于 tokenizer truncation),但发生时必须可观测——
      // 不再静默:记录被截断条数与最长原文长度,召回质量下降有迹可查。
      const overLimit = texts.filter((t) => t.length > 480);
      if (overLimit.length > 0) {
        console.warn(JSON.stringify({
          event: "local_embedding_truncated",
          model: LOCAL_EMBEDDING_MODEL,
          truncatedCount: overLimit.length,
          totalCount: texts.length,
          maxChars: 480,
          longestInput: Math.max(...overLimit.map((t) => t.length))
        }));
      }
      const safe = texts.map((t) => (t.length > 480 ? t.slice(0, 480) : t));
      const out = await extractor(safe, { pooling: "mean", normalize: true, truncation: true });
      return out.tolist(); // [n, 1024]
    }
  };
}
