/**
 * Minimal AWS SigV4 presign for S3 PutObject — no extra SDK dependency.
 * Supports virtual-hosted AWS S3, custom endpoints (MinIO/OSS), and path-style.
 */
import { createHash, createHmac } from "node:crypto";

export interface S3PresignPutInput {
  bucket: string;
  key: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresInSec?: number;
  contentType?: string;
  /** e.g. https://oss-cn-hangzhou.aliyuncs.com or http://127.0.0.1:9000 */
  endpoint?: string;
  /** Prefer /bucket/key. Defaults true when endpoint is set. */
  forcePathStyle?: boolean;
}

export interface S3PresignPutResult {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresInSec: number;
  addressing: "virtual-hosted" | "path-style";
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hashHex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

function encodeS3Key(key: string): string {
  return key.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

function resolveAddressing(input: S3PresignPutInput): {
  host: string;
  canonicalUri: string;
  urlBase: string;
  addressing: "virtual-hosted" | "path-style";
} {
  const region = input.region || "us-east-1";
  const keyPath = encodeS3Key(input.key);
  const endpoint = (input.endpoint ?? "").trim().replace(/\/$/, "");
  const forcePath =
    input.forcePathStyle === true ||
    (input.forcePathStyle !== false && endpoint.length > 0);

  if (!endpoint) {
    if (forcePath) {
      const host = `s3.${region}.amazonaws.com`;
      return {
        host,
        canonicalUri: `/${input.bucket}/${keyPath}`,
        urlBase: `https://${host}/${input.bucket}/${keyPath}`,
        addressing: "path-style"
      };
    }
    const host = `${input.bucket}.s3.${region}.amazonaws.com`;
    return {
      host,
      canonicalUri: `/${keyPath}`,
      urlBase: `https://${host}/${keyPath}`,
      addressing: "virtual-hosted"
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
  } catch {
    throw new Error(`Invalid CORPUS_S3_ENDPOINT: ${endpoint}`);
  }
  const host = parsed.host;
  const origin = `${parsed.protocol}//${host}`;
  if (forcePath) {
    return {
      host,
      canonicalUri: `/${input.bucket}/${keyPath}`,
      urlBase: `${origin}/${input.bucket}/${keyPath}`,
      addressing: "path-style"
    };
  }
  const vhHost = `${input.bucket}.${host}`;
  return {
    host: vhHost,
    canonicalUri: `/${keyPath}`,
    urlBase: `${parsed.protocol}//${vhHost}/${keyPath}`,
    addressing: "virtual-hosted"
  };
}

export function presignS3PutObject(input: S3PresignPutInput): S3PresignPutResult {
  const expiresInSec = Math.min(Math.max(input.expiresInSec ?? 3600, 60), 86400);
  const region = input.region || "us-east-1";
  const { host, canonicalUri, urlBase, addressing } = resolveAddressing(input);
  const { amz, date } = amzDate();
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const signedHeaders = input.sessionToken
    ? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token"
    : "host;x-amz-content-sha256;x-amz-date";

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expiresInSec),
    "X-Amz-SignedHeaders": signedHeaders
  };

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join("&");

  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amz}\n` +
    (input.sessionToken ? `x-amz-security-token:${input.sessionToken}\n` : "");

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", amz, credentialScope, hashHex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
  if (input.contentType) headers["content-type"] = input.contentType;

  return {
    method: "PUT",
    url: `${urlBase}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers,
    expiresInSec,
    addressing
  };
}

export type S3CorpusEnv =
  | {
      enabled: true;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      publicBaseUrl?: string;
      endpoint?: string;
      forcePathStyle: boolean;
    }
  | { enabled: false; reason: string };

function truthyEnv(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export function readS3CorpusEnv(env: Record<string, string | undefined> = process.env): S3CorpusEnv {
  const bucket = (env.CORPUS_S3_BUCKET ?? "").trim();
  const accessKeyId = (env.AWS_ACCESS_KEY_ID ?? env.CORPUS_S3_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY ?? env.CORPUS_S3_SECRET_ACCESS_KEY ?? "").trim();
  if (!bucket) return { enabled: false, reason: "CORPUS_S3_BUCKET unset" };
  if (!accessKeyId || !secretAccessKey) {
    return { enabled: false, reason: "S3 credentials unset (AWS_ACCESS_KEY_ID / CORPUS_S3_*)" };
  }
  const region = (env.AWS_REGION ?? env.CORPUS_S3_REGION ?? "us-east-1").trim() || "us-east-1";
  const sessionToken = (env.AWS_SESSION_TOKEN ?? env.CORPUS_S3_SESSION_TOKEN ?? "").trim() || undefined;
  const publicBaseUrl = (env.CORPUS_S3_PUBLIC_BASE_URL ?? "").trim() || undefined;
  const endpoint =
    (env.CORPUS_S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL ?? "").trim() || undefined;
  const forcePathStyle =
    env.CORPUS_S3_FORCE_PATH_STYLE !== undefined
      ? truthyEnv(env.CORPUS_S3_FORCE_PATH_STYLE)
      : Boolean(endpoint);
  return {
    enabled: true,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    publicBaseUrl,
    endpoint,
    forcePathStyle
  };
}
