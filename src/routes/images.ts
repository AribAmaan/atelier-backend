import { Router } from "express";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable, pipeline } from "node:stream";
import { asyncHandler } from "../lib/asyncHandler";
import { getClient, getBucketName } from "../lib/b2";

const router = Router();
router.get("/:key(*)", asyncHandler(async (req, res) => {
  // Express already URL-decodes route params. Never decode the key twice.
  const key = req.params.key;
  if (!/^(?:atelier|rolichat)\/avatars\/[a-zA-Z0-9_.-]+\.(?:png|jpe?g|webp|gif)$/i.test(key)) {
    return res.status(404).json({ error: "Image not found." });
  }
  const controller = new AbortController();
  let body: Readable | undefined;
  const disconnected = () => { if (!res.writableFinished) { controller.abort(); body?.destroy(); } };
  res.once("close", disconnected);
  let object;
  try {
    object = await getClient().send(new GetObjectCommand({
      Bucket: getBucketName(), Key: key, IfNoneMatch: req.get("If-None-Match"),
    }), { abortSignal: controller.signal });
  } catch (err: any) {
    res.off("close", disconnected);
    if (controller.signal.aborted) return;
    if (err?.$metadata?.httpStatusCode === 304 || err?.name === "NotModified") return res.status(304).end();
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: "Image not found." });
    throw err;
  }
  if (!(object.Body instanceof Readable)) {
    res.off("close", disconnected);
    return res.status(404).json({ error: "Image not found." });
  }
  body = object.Body;
  if (controller.signal.aborted || res.destroyed) { body.destroy(); return; }
  const type = object.ContentType?.split(";")[0];
  res.set({
    "Content-Type": type && /^image\/(png|jpeg|webp|gif)$/.test(type) ? type : "image/png",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
    ...(object.ETag ? { ETag: object.ETag } : {}),
    ...(object.ContentLength !== undefined ? { "Content-Length": String(object.ContentLength) } : {}),
  });
  pipeline(body, res, err => {
    res.off("close", disconnected);
    if (err && !controller.signal.aborted) console.error("[images] stream failed:", err.message);
  });
}));
export default router;
