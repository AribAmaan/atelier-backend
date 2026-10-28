/** Media downloads must be bounded until the final byte, not just the headers. */
const MAX_RESPONSE_BYTES = 21 * 1024 * 1024; // accommodates a 15 MB base64 image

export function imageTimeoutMs(): number {
  const seconds = Number(process.env.IMAGE_GEN_TIMEOUT_SECONDS ?? "45");
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 120 ? seconds * 1000 : 45_000;
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
    if (!response.ok) {
      const retryHeader = response.headers.get("retry-after");
      let retryHint = "";
      if (retryHeader) {
        const seconds = Number(retryHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
          retryHint = ` Retry-After: ${seconds}s.`;
        } else {
          const date = Date.parse(retryHeader);
          if (Number.isFinite(date)) retryHint = ` Retry-After: ${Math.max(0, (date - Date.now()) / 1000).toFixed(1)}s.`;
        }
      }
      throw new Error(`${provider} API error ${response.status}.${retryHint} ${body.toString("utf8").slice(0, 1000)}`);
    }
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
