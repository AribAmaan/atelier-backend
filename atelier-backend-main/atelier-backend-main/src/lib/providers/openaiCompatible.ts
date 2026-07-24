/**
 * Groq, NVIDIA NIM, and Cerebras all expose an OpenAI-compatible
 * /chat/completions endpoint, so they share this streaming parser and
 * non-streaming helper.
 *
 * Both functions take a `timeoutMs` and enforce it with an AbortController
 * — this is what makes the circuit breaker actually useful. Without a hard
 * timeout, a hanging provider (not erroring, just never responding) would
 * never trip the breaker and would block every request behind it forever.
 *
 * For streaming, the timeout only covers "time to first token" — once
 * tokens start arriving we know the provider is alive, so a long legitimate
 * reply isn't punished. For the non-streaming `complete` path (used for
 * memory summarization, not user-facing chat), the timeout covers the
 * whole request.
 */

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function readErrorBody(res: Response): Promise<string> {
  // Fold the response body into the thrown error so ProviderBreaker.trip()
  // can parse a provider's own "retry in Xs" hint out of it, instead of
  // always falling back to the generic default cooldown.
  const text = await res.text().catch(() => "");
  return text.slice(0, 500);
}

export async function streamOpenAICompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onToken: (chunk: string) => void,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  let firstTokenReceived = false;
  const timer = setTimeout(() => {
    if (!firstTokenReceived) controller.abort();
  }, timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Request to ${baseUrl} timed out after ${timeoutMs}ms waiting for a first response.`);
      }
      throw err;
    }

    if (!res.ok || !res.body) {
      const body = await readErrorBody(res);
      throw new Error(`Request to ${baseUrl} failed (${res.status}): ${body || "no response body"}`);
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
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error(`Request to ${baseUrl} timed out after ${timeoutMs}ms waiting for a first response.`);
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
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const token: string | undefined = parsed?.choices?.[0]?.delta?.content;
        if (token) {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            clearTimeout(timer);
          }
          fullText += token;
          onToken(token);
        }
      }
    }

    return fullText;
  } finally {
    clearTimeout(timer);
  }
}

export async function completeOpenAICompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Request to ${baseUrl} timed out after ${timeoutMs}ms.`);
      }
      throw err;
    }

    if (!res.ok) {
      const body = await readErrorBody(res);
      throw new Error(`Request to ${baseUrl} failed (${res.status}): ${body || "no response body"}`);
    }

    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}
