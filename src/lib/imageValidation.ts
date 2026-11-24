import sharp from "sharp";

const formats: Record<string, { extension: string; contentType: string }> = {
  png: { extension: "png", contentType: "image/png" },
  jpeg: { extension: "jpg", contentType: "image/jpeg" },
  webp: { extension: "webp", contentType: "image/webp" },
  gif: { extension: "gif", contentType: "image/gif" },
};

/** Detect the actual bytes; a browser-supplied MIME type is not evidence. */
export async function inspectImage(buffer: Buffer) {
  if (!buffer.length || buffer.length > 15 * 1024 * 1024) throw Object.assign(new Error("Image must be between 1 byte and 15 MB."), { status: 413, expose: true });
  try {
    const metadata = await sharp(buffer, { limitInputPixels: 40_000_000, animated: true }).metadata();
    const format = metadata.format && formats[metadata.format];
    if (!format || !metadata.width || !metadata.height) throw new Error("Unsupported image format.");
    return format;
  } catch {
    throw Object.assign(new Error("Send a valid PNG, JPEG, WebP, or GIF image under 40 megapixels."), { status: 400, expose: true });
  }
}
