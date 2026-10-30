import sharp from "sharp";

/**
 * One sharp pipeline for every AI-generated image: (optional resize) ->
 * sharpen -> WebP. Replaces the old "sharpen -> PNG encode, then resize ->
 * PNG encode again" flow, which re-encoded a multi-megabyte PNG twice on
 * Render's tiny free-plan CPU. WebP at q90 is visually indistinguishable here
 * but ~5-10x smaller, so the B2 upload AND the browser download (which is
 * streamed through this backend by /api/images/:key) finish much sooner.
 * Falls back to the original bytes if anything goes wrong.
 */
export async function finalizeGeneratedImage(
  bytes: Buffer,
  resize?: { width: number; height: number }
): Promise<Buffer> {
  try {
    let pipeline = sharp(bytes, { limitInputPixels: 40_000_000 });
    if (resize) pipeline = pipeline.resize(resize.width, resize.height, { fit: "cover" });
    return await pipeline.sharpen().webp({ quality: 90, effort: 3 }).toBuffer();
  } catch {
    return bytes;
  }
}
