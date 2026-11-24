import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import { inspectImage } from "./imageValidation";

// Avatars (uploaded or AI-generated) are stored on Backblaze B2 instead of
// local disk. This matters specifically on Render's free plan, which does
// not support persistent disks — anything written to local disk is wiped on
// every restart/redeploy. B2 objects are permanent regardless of how often
// the backend restarts.
//
// The bucket is kept PRIVATE — no card-on-file needed for B2's first-public-
// bucket verification. Instead the backend proxies/streams objects itself
// via GET /api/images/:key (see src/routes/images.ts). uploadAvatarBuffer
// returns that proxy URL, so callers never touch the B2 endpoint directly.
//
// B2 speaks the S3 API, so we just point the AWS SDK's S3 client at B2's
// S3-compatible endpoint. Free account: backblaze.com/b2 — 10GB free.
// Get these four values from the B2 dashboard (Application Keys page for
// the key id/app key, Bucket page for the bucket name/endpoint).

let client: S3Client | null = null;
let clientError: Error | null = null;
let clientErrorAt = 0;
const CLIENT_ERROR_RETRY_MS = 30_000;

export function getClient(): S3Client {
  if (client) return client;
  if (clientError && Date.now() - clientErrorAt < CLIENT_ERROR_RETRY_MS) {
    throw clientError;
  }

  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  const rawEndpoint = process.env.B2_ENDPOINT;

  if (!keyId || !appKey || !rawEndpoint) {
    const err = new Error(
      "B2 storage is not configured. Set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, and B2_ENDPOINT."
    );
    clientError = err;
    clientErrorAt = Date.now();
    throw err;
  }

  const endpoint = rawEndpoint.replace(/^https?:\/\//, "");
  const region = endpoint.split(".")[1] || "us-east-005";

  client = new S3Client({
    region,
    endpoint: `https://${endpoint}`,
    credentials: {
      accessKeyId: keyId,
      secretAccessKey: appKey,
    },
  });

  return client;
}

export function getBucketName(): string {
  const bucket = process.env.B2_BUCKET_NAME;
  if (!bucket) throw new Error("B2_BUCKET_NAME is not set.");
  return bucket;
}

function getProxyUrlBase(): string {
  // RENDER_EXTERNAL_URL is set automatically by Render on every service —
  // no manual config needed in production. Falls back to BACKEND_URL (or
  // localhost) for local dev.
  const base =
    process.env.RENDER_EXTERNAL_URL || process.env.BACKEND_URL || "http://localhost:4000";
  return base.replace(/\/$/, "");
}

export async function uploadAvatarBuffer(buffer: Buffer, publicId: string): Promise<string> {
  const image = await inspectImage(buffer);
  const s3 = getClient();
  const bucket = getBucketName();

  // Mirror the old Cloudinary "atelier/avatars/<publicId>" layout, and make
  // sure the key is unique even if callers reuse a publicId.
  const safeId = `${publicId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 160)}-${randomUUID().slice(0, 8)}.${image.extension}`;
  const key = `atelier/avatars/${safeId}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: image.contentType,
    })
  );

  // Proxy URL, not the raw B2 endpoint — bucket stays private.
  return `${getProxyUrlBase()}/api/images/${encodeURIComponent(key)}`;
}
