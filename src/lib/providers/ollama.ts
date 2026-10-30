/**
 * Talks to a locally-running Ollama server (https://ollama.com). Free and
 * unlimited (no API key, no rate limit beyond your own hardware), but slower
 * and lower quality than the hosted providers, and limited to the requests
 * one machine can actually process at a time. This is the always-available
 * floor of the fallback chain — tried last, after every hosted provider.
 */
import { recordTokenUsage, recordProviderAttempt } from "./tokenStats";
import type { GenParams } from "./index";

const BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "llama3.1";

function genParamsOptions(params?: GenParams): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (params?.temperature !== undefined) options.temperature = params.temperature;
  if (params?.topP !== undefined) options.top_p = params.topP;
  if (params?.maxTokens !== undefined) options.num_predict = params.maxTokens;
  return Object.keys(options).length ? options : undefined;
}

export async function isOllamaAvailable(timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    // Readiness needs only status. Cancel the unused body to release its socket.
    void res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function streamOllamaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  timeoutMs: number,
  clientSignal?: AbortSignal,
  params?: GenParams
): Promise<string> {
  const controller = new AbortController();
  let firstTokenReceived = false;
  let finishReason = "unknown";
  let chunkTimer: ReturnType<typeof setTimeout> | null = null;
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
      recordProviderAttempt();
      res = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: true, options: genParamsOptions(params) }),
        signal: controller.signal,
      });
    } catch (err) {
      if (clientAborted) return "";
      if (err instanceof Error && err.name === "AbortError") {
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
    const resetChunkTimer = () => {
      if (chunkTimer) clearTimeout(chunkTimer);
      chunkTimer = setTimeout(() => {
        if (!clientAborted) controller.abort();
      }, timeoutMs);
    };
    resetChunkTimer();

    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (clientAborted) return fullText;
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(firstTokenReceived
            ? `Ollama stream stalled for ${timeoutMs}ms mid-response.`
            : `Ollama timed out after ${timeoutMs}ms waiting for a first response.`);
        }
        throw err;
      }
      const { done, value } = chunk;
      if (done && !buffer) break;
      if (!done) resetChunkTimer();
      buffer += done ? decoder.decode() + "\n" : decoder.decode(value, { stream: true });

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
        if (parsed?.done) {
          finishReason = parsed.done_reason ?? "unknown";
          if (typeof parsed.prompt_eval_count === "number" && typeof parsed.eval_count === "number")
            recordTokenUsage(`ollama:${MODEL}`, parsed.prompt_eval_count, parsed.eval_count);
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
      if (done) break;
    }

    params?.onFinish?.(finishReason);
    return fullText;
  } finally {
    clearTimeout(timer);
    if (chunkTimer) clearTimeout(chunkTimer);
    if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
  }
}

export async function completeOllamaChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  timeoutMs: number,
  params?: GenParams
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      recordProviderAttempt();
      res = await fetch(`${BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: false, options: genParamsOptions(params) }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Ollama timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama request failed (${res.status}): ${text || "no response body"}`);
    }
    const data = await res.json();
    if (typeof data.prompt_eval_count === "number" && typeof data.eval_count === "number")
      recordTokenUsage(`ollama:${MODEL}`, data.prompt_eval_count, data.eval_count);
    if (params?.requireComplete && data?.done_reason !== "stop") throw new Error("Ollama memory completion did not finish normally.");
    return data?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}
