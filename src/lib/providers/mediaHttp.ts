/** Media downloads must be bounded until the final byte, not just the headers. */
const MAX_RESPONSE_BYTES = 21 * 1024 * 1024; // accommodates a 15 MB base64 image

export function imageTimeoutMs(): number {
  const seconds = Number(process.env.IMAGE_GEN_TIMEOUT_SECONDS ?? "45");
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 120 ? seconds * 1000 : 45_000;
}

/**
 * Cloudflare Workers AI gets its OWN deadline, independent of
 * IMAGE_GEN_TIMEOUT_SECONDS. FLUX.2 Klein 4B normally answers in ~3-10s; if it
 * has not answered in 20s it is hung/queued, and waiting longer only makes the
 * user wait longer (a 60s default made every failed call cost a full minute
 * before the fallback even started). Default 20s, range 10-170s.
 */
export function cloudflareImageTimeoutMs(): number {
  const seconds = Number(process.env.CLOUDFLARE_IMAGE_TIMEOUT_SECONDS ?? "20");
  return Number.isFinite(seconds) && seconds >= 10 && seconds <= 170 ? seconds * 1000 : 20_000;
}

/**
 * Pollinations deadline. Never lower than 30s even if a stale
 * IMAGE_GEN_TIMEOUT_SECONDS=15 is sitting in the Render dashboard (that value
 * was killing Pollinations calls that would have succeeded).
 */
export function pollinationsImageTimeoutMs(): number {
  return Math.max(imageTimeoutMs(), 30_000);
}

/**
 * Hedge delay: if the current provider has not answered after this long, the
 * next provider is started in parallel (first valid image wins). 0 disables.
 */
export function imageHedgeMs(): number {
  const seconds = Number(process.env.IMAGE_HEDGE_SECONDS ?? "8");
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 60 ? seconds * 1000 : 8_000;
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
