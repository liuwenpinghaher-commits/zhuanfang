import { describe, expect, it } from "vitest";
import { presignS3PutObject, readS3CorpusEnv } from "./s3-presign";

describe("readS3CorpusEnv", () => {
  it("disabled without bucket", () => {
    expect(readS3CorpusEnv({}).enabled).toBe(false);
  });

  it("enabled with bucket + keys", () => {
    const r = readS3CorpusEnv({
      CORPUS_S3_BUCKET: "my-bucket",
      AWS_ACCESS_KEY_ID: "AKIATEST",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "ap-northeast-1"
    });
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.bucket).toBe("my-bucket");
      expect(r.region).toBe("ap-northeast-1");
      expect(r.forcePathStyle).toBe(false);
    }
  });
});

describe("presignS3PutObject", () => {
  it("returns signed https PUT url", () => {
    const out = presignS3PutObject({
      bucket: "my-bucket",
      key: "corpus/a.wav",
      region: "us-east-1",
      accessKeyId: "AKIATEST",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresInSec: 900
    });
    expect(out.method).toBe("PUT");
    expect(out.url).toContain("https://my-bucket.s3.us-east-1.amazonaws.com/corpus/a.wav?");
    expect(out.url).toContain("X-Amz-Signature=");
    expect(out.expiresInSec).toBe(900);
  });
});


describe("presignS3PutObject path-style / custom endpoint", () => {
  it("uses path-style on custom endpoint by default", () => {
    const out = presignS3PutObject({
      bucket: "my-bucket",
      key: "corpus/a.wav",
      region: "oss-cn-hangzhou",
      accessKeyId: "AKIATEST",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
      expiresInSec: 900
    });
    expect(out.addressing).toBe("path-style");
    expect(out.url).toContain("https://oss-cn-hangzhou.aliyuncs.com/my-bucket/corpus/a.wav?");
    expect(out.url).toContain("X-Amz-Signature=");
  });

  it("readS3CorpusEnv defaults forcePathStyle when endpoint set", () => {
    const r = readS3CorpusEnv({
      CORPUS_S3_BUCKET: "b",
      CORPUS_S3_ACCESS_KEY_ID: "a",
      CORPUS_S3_SECRET_ACCESS_KEY: "s",
      CORPUS_S3_ENDPOINT: "http://127.0.0.1:9000"
    });
    expect(r.enabled).toBe(true);
    if (r.enabled) {
      expect(r.forcePathStyle).toBe(true);
      expect(r.endpoint).toContain("127.0.0.1");
    }
  });
});
