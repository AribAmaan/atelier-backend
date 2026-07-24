import { streamOpenAICompatibleChat, completeOpenAICompatibleChat } from "./openaiCompatible";

const BASE_URL = "https://api.groq.com/openai/v1";
const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

export function isGroqConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

/**
 * The two configured Groq API keys, if any. A second key is optional —
 * ideally from a SEPARATE Groq account/signup, since most providers
 * enforce free-tier limits per account, not per key, so two keys from one
 * account may still share a single limit. Leave GROQ_API_KEY_2 unset to
 * just use one key; the slot is then simply left out of the fallback chain.
 *
 * Returns each configured key tagged with its original 1-based slot number
 * rather than its position in this filtered array — otherwise, if only
 * GROQ_API_KEY_2 is set, that key would end up at array index 0 and get
 * labeled "Grok #1" even though it's really the second key.
 */
export function getGroqKeys(): { key: string; slot: number }[] {
  return [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2]
    .map((key, i) => ({ key, slot: i + 1 }))
    .filter((entry): entry is { key: string; slot: number } => Boolean(entry.key));
}

export async function streamGroqChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  onToken: (chunk: string) => void,
  apiKey: string,
  timeoutMs: number,
  clientSignal?: AbortSignal
): Promise<string> {
  return streamOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, onToken, timeoutMs, clientSignal);
}

export async function completeGroqChat(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  apiKey: string,
  timeoutMs: number
): Promise<string> {
  return completeOpenAICompatibleChat(BASE_URL, apiKey, MODEL, messages, timeoutMs);
}

// ---------------------------------------------------------------------------
// Text-to-speech (Orpheus, via Groq)
// ---------------------------------------------------------------------------

const TTS_MODEL = "canopylabs/orpheus-v1-english";
// Hard limit set by Groq's Orpheus endpoint — inputs over this are rejected outright.
export const TTS_MAX_CHARS = 200;

export const TTS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"] as const;
export type TtsVoice = (typeof TTS_VOICES)[number];

/** Synthesizes a single chunk of text (must already be <= TTS_MAX_CHARS) into
 * WAV audio bytes. Callers needing longer text should split it first — see
 * splitForSpeech() in this module. */
export async function synthesizeGroqSpeech(
  text: string,
  voice: TtsVoice,
  apiKey: string,
  timeoutMs: number
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: "wav" }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq TTS failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Splits text into chunks that each fit under TTS_MAX_CHARS, preferring to
 * break on sentence boundaries (falling back to a hard split only for a
 * single sentence that's already too long on its own). */
export function splitForSpeech(text: string, maxChars: number = TTS_MAX_CHARS): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      // A single sentence longer than the limit on its own — hard-split on
      // word boundaries as a fallback so nothing gets silently dropped.
      let rest = sentence;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(" ", maxChars);
        if (cut <= 0) cut = maxChars;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest;
      continue;
    }
    if ((current + " " + sentence).trim().length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = (current + " " + sentence).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

/** Groq's Orpheus WAV output has a standard RIFF/WAVE/fmt /data layout.
 * Playing several chunks back as one clip needs a single valid WAV file, not
 * several concatenated headers, so this rewrites one combined header over
 * the concatenated PCM payloads instead. */
export function concatWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 1) return buffers[0];

  function findDataChunk(buffer: Buffer): { headerBeforeData: Buffer; data: Buffer } {
    let offset = 12; // past "RIFF" + size(4) + "WAVE"
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString("ascii", offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        return { headerBeforeData: buffer.subarray(0, offset), data: buffer.subarray(offset + 8, offset + 8 + chunkSize) };
      }
      offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
    }
    throw new Error("No 'data' chunk found in WAV audio from TTS provider.");
  }

  const parsed = buffers.map(findDataChunk);
  const totalDataLength = parsed.reduce((sum, p) => sum + p.data.length, 0);
  const header = Buffer.from(parsed[0].headerBeforeData); // fmt chunk etc., identical across chunks from the same call
  header.writeUInt32LE(header.length + 8 + totalDataLength - 8, 4); // RIFF chunk size

  const dataTag = Buffer.alloc(8);
  dataTag.write("data", 0, "ascii");
  dataTag.writeUInt32LE(totalDataLength, 4);

  return Buffer.concat([header, dataTag, ...parsed.map((p) => p.data)]);
}
