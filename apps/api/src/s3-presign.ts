/**
 * Minimal AWS SigV4 presign for S3 PutObject — no extra SDK dependency.
 * Used only when CORPUS_S3_BUCKET + AWS credentials are configured.
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
}

export interface S3PresignPutResult {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresInSec: number;
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

export function presignS3PutObject(input: S3PresignPutInput): S3PresignPutResult {
  const expiresInSec = Math.min(Math.max(input.expiresInSec ?? 3600, 60), 86400);
  const region = input.region || "us-east-1";
  const host = `${input.bucket}.s3.${region}.amazonaws.com`;
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
    `/${input.key.split("/").map(encodeURIComponent).join("/")}`,
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

  const url = `https://${host}/${input.key.split("/").map(encodeURIComponent).join("/")}?${canonicalQuery}&X-Amz-Signature=${signature}`;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
  if (input.contentType) headers["content-type"] = input.contentType;

  return { method: "PUT", url, headers, expiresInSec };
}

export function readS3CorpusEnv(env: Record<string, string | undefined>): {
  enabled: boolean;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  publicBaseUrl?: string;
  reason?: string;
} {
  const bucket = (env.CORPUS_S3_BUCKET ?? "").trim();
  const accessKeyId = (env.AWS_ACCESS_KEY_ID ?? env.CORPUS_S3_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY ?? env.CORPUS_S3_SECRET_ACCESS_KEY ?? "").trim();
  const region = (env.AWS_REGION ?? env.CORPUS_S3_REGION ?? "us-east-1").trim();
  const sessionToken = (env.AWS_SESSION_TOKEN ?? env.CORPUS_S3_SESSION_TOKEN ?? "").trim() || undefined;
  const publicBaseUrl = (env.CORPUS_S3_PUBLIC_BASE_URL ?? "").trim() || undefined;

  if (!bucket) return { enabled: false, reason: "CORPUS_S3_BUCKET unset" };
  if (!accessKeyId || !secretAccessKey) {
    return { enabled: false, bucket, region, reason: "AWS credentials missing" };
  }
  return {
    enabled: true,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    publicBaseUrl
  };
}
