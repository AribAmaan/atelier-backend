/**
 * Talks to a locally-running Ollama server (https://ollama.com). Free and
 * unlimited (no API key, no rate limit beyond your own hardware), but slower
 * and lower quality than the hosted providers, and limited to the requests
 * one machine can actually process at a time. This is the always-available
 * floor of the fallback chain — tried last, after every hosted provider.
 */

const BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "llama3.1";

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function streamOllamaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  timeoutMs: number,
  clientSignal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  let firstTokenReceived = false;
  // See openaiCompatible.ts — same client-stop vs. provider-timeout distinction.
  let clientAborted = clientSignal?.aborted ?? false;
  const onClientAbort = () => {
    clientAborted = true;
    controller.abort();
  };
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", onClientAbort);
  }
  const timer = setTimeout(() => {
    if (!firstTokenReceived) controller.abort();
  }, timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: true }),
        signal: controller.signal,
      });
    } catch (err) {
      if (clientAborted) return "";
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Ollama timed out after ${timeoutMs}ms waiting for a first response.`);
      }
      throw err;
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama request failed (${res.status}): ${text || "no response body"}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (clientAborted) return fullText;
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error(`Ollama timed out after ${timeoutMs}ms waiting for a first response.`);
        }
        throw err;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const token: string | undefined = parsed?.message?.content;
        if (token) {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            clearTimeout(timer);
          }
          fullText += token;
          onToken(token);
        }
      }
      if (clientAborted) return fullText;
    }

    return fullText;
  } finally {
    clearTimeout(timer);
    if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
  }
}

export async function completeOllamaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: false }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Ollama timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama request failed (${res.status}): ${text || "no response body"}`);
    }
    const data = await res.json();
    return data?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}
