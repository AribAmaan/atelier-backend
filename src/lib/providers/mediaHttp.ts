/** Media downloads must be bounded until the final byte, not just the headers. */
const MAX_RESPONSE_BYTES = 21 * 1024 * 1024; // accommodates a 15 MB base64 image

export function imageTimeoutMs(): number {
  const seconds = Number(process.env.IMAGE_GEN_TIMEOUT_SECONDS ?? "45");
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 120 ? seconds * 1000 : 45_000;
}

/**
 * Cloudflare Workers AI gets its own, longer deadline. It was sharing the 45s
 * IMAGE_GEN_TIMEOUT_SECONDS with Pollinations/DiceBear, so slow Workers AI
 * responses (cold starts, 1920x1080 backgrounds, capacity waits) kept timing
 * out. Valid range: 1-300 seconds; invalid values fall back to 60 seconds.
 */
export const DEFAULT_CLOUDFLARE_IMAGE_TIMEOUT_MS = 60_000;
export function cloudflareImageTimeoutMs(): number {
  const raw = process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS;
  const seconds = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 300
    ? seconds * 1000
    : DEFAULT_CLOUDFLARE_IMAGE_TIMEOUT_MS;
}

/**
 * Hard cap on the TOTAL time one image request may spend across the whole
 * provider chain (Cloudflare + Pollinations). Each provider's own timeout is
 * clamped to whatever is left, so a customer never waits longer than this
 * before getting a result or a clear error. Valid range: 10-300 seconds;
 * invalid values fall back to 75 seconds.
 */
export const DEFAULT_IMAGE_TOTAL_BUDGET_MS = 75_000;
export function imageTotalBudgetMs(): number {
  const raw = process.env.IMAGE_GEN_TOTAL_BUDGET_SECONDS;
  const seconds = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds >= 10 && seconds <= 300
    ? seconds * 1000
    : DEFAULT_IMAGE_TOTAL_BUDGET_MS;
}

export async function requestMediaResource(
  url: string, init: RequestInit, provider: string, timeoutMs: number
): Promise<{ body: Buffer; contentType: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid media request timeout.");
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${provider} request timed out after ${timeoutMs / 1000}s`));
      controller.abort();
      void reader?.cancel().catch(() => {});
    }, timeoutMs);
  });
  const download = async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (controller.signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`${provider} request aborted`);
    }
    const limit = response.ok ? MAX_RESPONSE_BYTES : 4096;
    reader = response.body?.getReader();
    if (response.ok && Number(response.headers.get("content-length")) > limit) {
      throw new Error(`${provider} response exceeds the media size limit`);
    }
    const chunks: Buffer[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = limit - length;
        if (value.byteLength > remaining && response.ok) {
          throw new Error(`${provider} response exceeds the media size limit`);
        }
        const chunk = Buffer.from(value.subarray(0, remaining));
        chunks.push(chunk);
        length += chunk.length;
        if (!response.ok && length >= limit) break;
      }
    }
    const body = Buffer.concat(chunks, length);
    if (!response.ok) throw new Error(`${provider} API error ${response.status}: ${body.toString("utf8").slice(0, 300)}`);
    if (!body.length) throw new Error(`${provider} returned an empty media response`);
    return { body, contentType: (response.headers.get("content-type") || "").toLowerCase() };
  };
  try {
    return await Promise.race([deadline, download()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => {});
  }
}
