// Tencent COS client for firmware artifacts. Ported from the mbook project's
// lib/tencent-cos.ts and extended with getTencentCosObject so the firmware
// download endpoint can proxy-stream bytes from COS (the device pins Let's
// Encrypt roots and only talks to our domain, so we never hand it a COS URL).
import COS from "cos-nodejs-sdk-v5";

interface TencentCosConfig {
  bucket: string;
  region: string;
}

let tencentCosClient: COS | null = null;

function readTencentCosEnv() {
  return {
    secretId: process.env.TENCENT_COS_SECRET_ID?.trim() ?? "",
    secretKey: process.env.TENCENT_COS_SECRET_KEY?.trim() ?? "",
    bucket: process.env.TENCENT_COS_BUCKET?.trim() ?? "",
    region: process.env.TENCENT_COS_REGION?.trim() ?? "",
  };
}

export function isTencentCosConfigured() {
  const env = readTencentCosEnv();
  return Boolean(env.secretId && env.secretKey && env.bucket && env.region);
}

function getTencentCosConfig(): TencentCosConfig {
  const env = readTencentCosEnv();

  if (!env.secretId || !env.secretKey || !env.bucket || !env.region) {
    throw new Error("Tencent COS env vars are not fully configured");
  }

  if (!tencentCosClient) {
    tencentCosClient = new COS({
      SecretId: env.secretId,
      SecretKey: env.secretKey,
      Protocol: "https:",
    });
  }

  return {
    bucket: env.bucket,
    region: env.region,
  };
}

function getTencentCosClient() {
  getTencentCosConfig();
  return tencentCosClient as COS;
}

export async function putTencentCosObject(params: {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength?: number;
}) {
  const config = getTencentCosConfig();
  const client = getTencentCosClient();

  return client.putObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: params.key,
    Body: params.body,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
  });
}

// Fetch the full object bytes. Used to proxy-stream a firmware binary back to
// the device with an exact Content-Length. Binaries are ~1-2 MB, so buffering
// the whole object is acceptable here.
export async function getTencentCosObject(key: string): Promise<Buffer> {
  const config = getTencentCosConfig();
  const client = getTencentCosClient();

  const res = await client.getObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: key,
  });
  return res.Body as Buffer;
}

export async function deleteTencentCosObject(key: string) {
  const config = getTencentCosConfig();
  const client = getTencentCosClient();

  return client.deleteObject({
    Bucket: config.bucket,
    Region: config.region,
    Key: key,
  });
}
